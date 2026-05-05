import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	acquireLock,
	artifactDir,
	cleanupOldArtifacts,
	findSimilarArtifacts,
	formatSize,
	jewelryForComplexity,
	listArtifactsFromDisk,
	readArtifactFromDisk,
	releaseLock,
	slugify,
	timeSince,
	writeArtifactToDisk,
} from "../helpers.js";
import { ARTIFACTS_DIR } from "../types.js";
import type { Artifact } from "../types.js";

function makeArtifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
	const now = new Date().toISOString();
	return {
		id,
		title: id,
		type: "general",
		created_at: now,
		updated_at: now,
		size_bytes: 0,
		first_input_tokens: null,
		cursor: { last_processed_entry_id: null },
		data: {},
		checkpoints: [],
		...overrides,
	};
}

function purgeArtifacts() {
	rmSync(ARTIFACTS_DIR, { recursive: true, force: true });

	mkdirSync(ARTIFACTS_DIR, { recursive: true });

}

afterEach(() => {
	purgeArtifacts();
});

describe("slugify", () => {
	it("lowercases and replaces non-alphanumerics with dashes", () => {
		expect(slugify("Hello World!")).toBe("hello-world");
	});

	it("strips leading and trailing dashes", () => {
		expect(slugify("---abc---")).toBe("abc");
	});

	it("truncates to 60 chars", () => {
		const long = "a".repeat(120);
		expect(slugify(long).length).toBe(60);
	});

	it("collapses repeated separators", () => {
		expect(slugify("a   b   c")).toBe("a-b-c");
	});
});

describe("formatSize", () => {
	it("returns bytes below 1024", () => {
		expect(formatSize(512)).toBe("512B");
	});

	it("returns KB between 1KB and 1MB", () => {
		expect(formatSize(2048)).toBe("2.0KB");
	});

	it("returns MB above 1MB", () => {
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("jewelryForComplexity", () => {
	it("returns a dot for trivial complexity", () => {
		expect(jewelryForComplexity(0, 0)).toBe(".");
		expect(jewelryForComplexity(2, 2)).toBe(".");
	});

	it("escalates with complexity", () => {
		expect(jewelryForComplexity(3, 2)).toBe("*");
		expect(jewelryForComplexity(8, 8)).toBe("**");
		expect(jewelryForComplexity(15, 15)).toBe("***");
	});
});

describe("timeSince", () => {
	it("returns seconds for fresh dates", () => {
		const d = new Date(Date.now() - 5_000);
		expect(timeSince(d)).toBe("5s ago");
	});

	it("returns minutes after 60s", () => {
		const d = new Date(Date.now() - 5 * 60_000);
		expect(timeSince(d)).toBe("5m ago");
	});

	it("returns hours after 60m", () => {
		const d = new Date(Date.now() - 3 * 60 * 60_000);
		expect(timeSince(d)).toBe("3h ago");
	});

	it("returns days after 24h", () => {
		const d = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		expect(timeSince(d)).toBe("2d ago");
	});
});

describe("writeArtifactToDisk + readArtifactFromDisk", () => {
	it("round-trips an artifact and recomputes size_bytes", () => {
		const a = makeArtifact("round-trip-1", { data: { hello: "world" } });
		writeArtifactToDisk(a);
		expect(a.size_bytes).toBeGreaterThan(0);

		const back = readArtifactFromDisk("round-trip-1");
		expect(back).not.toBeNull();
		expect(back!.id).toBe("round-trip-1");
		expect(back!.data).toEqual({ hello: "world" });
		expect(back!.size_bytes).toBe(a.size_bytes);
	});

	it("returns null for a missing artifact", () => {
		expect(readArtifactFromDisk("does-not-exist")).toBeNull();
	});

	it("does not throw on corrupt JSON", () => {
		const dir = artifactDir("corrupt-1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "artifact.json"), "{not json", "utf-8");
		expect(readArtifactFromDisk("corrupt-1")).toBeNull();
	});
});

describe("listArtifactsFromDisk", () => {
	it("lists artifacts from V2 path and dedupes by id", () => {
		const a = makeArtifact("listed-a", { updated_at: new Date(Date.now() - 1000).toISOString() });
		const b = makeArtifact("listed-b", { updated_at: new Date().toISOString() });
		writeArtifactToDisk(a);
		writeArtifactToDisk(b);

		const all = listArtifactsFromDisk();
		const ids = all.map((x) => x.id);
		expect(ids).toContain("listed-a");
		expect(ids).toContain("listed-b");
	});

	it("sorts most-recently-updated first", () => {
		writeArtifactToDisk(makeArtifact("older", { updated_at: new Date(Date.now() - 60_000).toISOString() }));
		writeArtifactToDisk(makeArtifact("newer", { updated_at: new Date().toISOString() }));
		const all = listArtifactsFromDisk();
		expect(all[0].id).toBe("newer");
	});
});

describe("findSimilarArtifacts", () => {
	it("flags near-duplicate titles", () => {
		writeArtifactToDisk(makeArtifact("pr-review-triage", { title: "PR Review Triage" }));
		const similar = findSimilarArtifacts("PR Review Triage Today");
		expect(similar.length).toBeGreaterThan(0);
		expect(similar[0].similarity).toBeGreaterThanOrEqual(0.5);
	});

	it("ignores unrelated titles", () => {
		writeArtifactToDisk(makeArtifact("perf-investigation", { title: "Performance investigation" }));
		const similar = findSimilarArtifacts("Onboarding plan for new hires");
		expect(similar.length).toBe(0);
	});

	it("excludes the given id from results", () => {
		writeArtifactToDisk(makeArtifact("review-triage", { title: "Review triage" }));
		const similar = findSimilarArtifacts("Review triage", "review-triage");
		expect(similar.length).toBe(0);
	});
});

describe("acquireLock + releaseLock", () => {
	it("creates and removes a lock file", async () => {
		const id = "lock-target";
		await acquireLock(id);
		releaseLock(id);
		await acquireLock(id);
		releaseLock(id);
	});

	it("serializes concurrent writers", async () => {
		const id = "lock-concurrent";
		const order: number[] = [];

		async function writer(n: number) {
			await acquireLock(id);
			try {
				order.push(n);
				await new Promise((r) => setTimeout(r, 5));
				order.push(n);
			} finally {
				releaseLock(id);
			}
		}

		await Promise.all([writer(1), writer(2), writer(3)]);

		expect(order.length).toBe(6);
		for (let i = 0; i < order.length; i += 2) {
			expect(order[i]).toBe(order[i + 1]);
		}
	});
});

describe("cleanupOldArtifacts", () => {
	it("removes artifacts older than the cutoff and keeps fresh ones", () => {
		const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
		const freshTs = new Date().toISOString();
		writeArtifactToDisk(makeArtifact("stale", { updated_at: oldTs }));
		writeArtifactToDisk(makeArtifact("fresh", { updated_at: freshTs }));

		const cleaned = cleanupOldArtifacts(7);
		expect(cleaned).toBeGreaterThanOrEqual(1);
		expect(readArtifactFromDisk("stale")).toBeNull();
		expect(readArtifactFromDisk("fresh")).not.toBeNull();
	});
});
