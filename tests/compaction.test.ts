import { describe, expect, it } from "vitest";

import { buildDeterministicSummary } from "../compaction.js";
import type { ADAState, Artifact } from "../types.js";

function stateWith(artifact: Artifact | null): ADAState {
	return { artifact, inputOverCap: false };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
	const now = new Date().toISOString();
	return {
		id: "summary-test",
		title: "Summary Test",
		type: "build",
		created_at: now,
		updated_at: now,
		size_bytes: 1024,
		first_input_tokens: null,
		cursor: { last_processed_entry_id: null },
		data: {},
		checkpoints: [],
		...overrides,
	};
}

describe("buildDeterministicSummary", () => {
	it("returns empty string when no artifact is active", () => {
		expect(buildDeterministicSummary(stateWith(null))).toBe("");
	});

	it("includes the title and type in the header", () => {
		const summary = buildDeterministicSummary(stateWith(makeArtifact({ title: "My Work", type: "investigation" })));
		expect(summary).toContain('"My Work"');
		expect(summary).toContain("(investigation)");
	});

	it("emits a Data Keys section when data is non-empty", () => {
		const a = makeArtifact({ data: { foo: "bar", count: 42 } });
		const summary = buildDeterministicSummary(stateWith(a));
		expect(summary).toContain("### Data Keys (2)");
		expect(summary).toContain("**foo**");
		expect(summary).toContain("**count**");
	});

	it("omits Data Keys section when data is empty", () => {
		const summary = buildDeterministicSummary(stateWith(makeArtifact({ data: {} })));
		expect(summary).not.toContain("### Data Keys");
	});

	it("truncates long string values to 200 chars", () => {
		const long = "x".repeat(500);
		const summary = buildDeterministicSummary(stateWith(makeArtifact({ data: { big: long } })));
		const line = summary.split("\n").find((l) => l.includes("**big**"))!;
		expect(line.length).toBeLessThan(250);
	});

	it("emits the last 10 checkpoints when there are more than 10", () => {
		const cps = Array.from({ length: 15 }, (_, i) => ({
			timestamp: new Date(Date.now() - (15 - i) * 1000).toISOString(),
			note: `step ${i}`,
		}));
		const summary = buildDeterministicSummary(stateWith(makeArtifact({ checkpoints: cps })));
		expect(summary).toContain("Recent Checkpoints (last 10 of 15)");
		expect(summary).toContain("step 14");
		expect(summary).not.toContain("step 0");
	});

	it("omits Checkpoints section when there are none", () => {
		const summary = buildDeterministicSummary(stateWith(makeArtifact({ checkpoints: [] })));
		expect(summary).not.toContain("### Recent Checkpoints");
	});

	it("includes size, created_at, and updated_at footer", () => {
		const a = makeArtifact({ size_bytes: 4096, created_at: "2026-05-04T10:00:00.000Z", updated_at: "2026-05-04T11:00:00.000Z" });
		const summary = buildDeterministicSummary(stateWith(a));
		expect(summary).toContain("Size: 4.0KB");
		expect(summary).toContain("Created: 2026-05-04T10:00:00.000Z");
		expect(summary).toContain("Updated: 2026-05-04T11:00:00.000Z");
	});
});
