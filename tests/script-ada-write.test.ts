import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "ada-write.js");

interface Artifact {
	id: string;
	title: string;
	type: string;
	created_at: string;
	updated_at: string;
	size_bytes: number;
	first_input_tokens: number | null;
	cursor: { last_processed_entry_id: string | null };
	data: Record<string, unknown>;
	inputs: Array<{ timestamp: string; content: string }>;
	checkpoints: Array<{ timestamp: string; note: string }>;
}

let TMP_HOME: string;

function todayDateStamp(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}${m}${day}`;
}

function artifactPath(id: string, dateStamp = todayDateStamp()): string {
	return join(TMP_HOME, ".pi", "agent", "ada", "artifacts", dateStamp, id, "artifact.json");
}

function readArtifact(id: string, dateStamp?: string): Artifact | null {
	const p = artifactPath(id, dateStamp);
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8")) as Artifact;
}

function runScript(args: string[], stdinPayload?: string): { stdout: string; stderr: string } {
	const out = execFileSync("node", [SCRIPT, ...args], {
		env: { ...process.env, HOME: TMP_HOME },
		input: stdinPayload,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { stdout: out, stderr: "" };
}

function seedArtifact(a: Artifact, dateStamp = todayDateStamp()): void {
	const p = artifactPath(a.id, dateStamp);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(a, null, 2), "utf-8");
}

beforeEach(() => {
	TMP_HOME = mkdtempSync(join(tmpdir(), "ada-script-test-"));
});

afterEach(() => {
	rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("ada-write.js track-input", () => {
	it("creates a new artifact when none exists", () => {
		runScript(["track-input", "demo-id", "Demo title"], "hello world\n");

		const a = readArtifact("demo-id");
		expect(a).not.toBeNull();
		expect(a!.id).toBe("demo-id");
		expect(a!.title).toBe("Demo title");
		expect(a!.type).toBe("general");
		expect(a!.inputs).toHaveLength(1);
		expect(a!.inputs[0].content).toBe("hello world\n");
		expect(a!.checkpoints).toHaveLength(0);
		expect(a!.data).toEqual({});
		expect(a!.size_bytes).toBeGreaterThan(0);
	});

	it("preserves verbatim multi-line user input in inputs[]", () => {
		const input = "line one\nline two\n  indented line three";
		runScript(["track-input", "multi-line", "ML"], input);

		const a = readArtifact("multi-line");
		expect(a!.inputs[0].content).toBe(input);
	});

	it("appends a new input without losing prior ones", () => {
		runScript(["track-input", "two-turn", "Two turn"], "first input");
		runScript(["track-input", "two-turn", "Two turn"], "second input");

		const a = readArtifact("two-turn");
		expect(a!.inputs).toHaveLength(2);
		expect(a!.inputs[0].content).toBe("first input");
		expect(a!.inputs[1].content).toBe("second input");
		expect(a!.checkpoints).toHaveLength(0);
	});

	it("never adds the user input to the checkpoints array", () => {
		runScript(["track-input", "no-mix", "NoMix"], "my input");
		const a = readArtifact("no-mix");
		expect(a!.checkpoints).toEqual([]);
		for (const cp of a!.checkpoints) {
			expect(cp.note).not.toContain("my input");
		}
	});

	it("never overwrites existing data, checkpoints, or cursor when appending an input", () => {
		seedArtifact({
			id: "with-data",
			title: "With data",
			type: "general",
			created_at: "2026-05-04T10:00:00-04:00",
			updated_at: "2026-05-04T10:00:00-04:00",
			size_bytes: 0,
			first_input_tokens: 1234,
			cursor: { last_processed_entry_id: "abc" },
			data: { decisions: ["keep these"], counts: 7 },
			inputs: [{ timestamp: "2026-05-04T10:00:00-04:00", content: "original input" }],
			checkpoints: [{ timestamp: "2026-05-04T10:00:00-04:00", note: "assistant did X" }],
		});

		runScript(["track-input", "with-data", "With data"], "new input");

		const a = readArtifact("with-data");
		expect(a!.data).toEqual({ decisions: ["keep these"], counts: 7 });
		expect(a!.first_input_tokens).toBe(1234);
		expect(a!.cursor.last_processed_entry_id).toBe("abc");
		expect(a!.inputs).toHaveLength(2);
		expect(a!.inputs[1].content).toBe("new input");
		expect(a!.checkpoints).toHaveLength(1);
		expect(a!.checkpoints[0].note).toBe("assistant did X");
	});

	it("uses local timezone in timestamps, not UTC", () => {
		runScript(["track-input", "tz-check", "TZ"], "x");
		const a = readArtifact("tz-check");
		expect(a!.created_at).toMatch(/[+-]\d{2}:\d{2}$/);
		expect(a!.updated_at).toMatch(/[+-]\d{2}:\d{2}$/);
		expect(a!.inputs[0].timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
	});

	it("recomputes size_bytes on every write", () => {
		runScript(["track-input", "size-check", "Size"], "small");
		const a1 = readArtifact("size-check");
		const size1 = a1!.size_bytes;

		runScript(["track-input", "size-check", "Size"], "second input that adds more bytes than the first");
		const a2 = readArtifact("size-check");

		expect(a2!.size_bytes).toBeGreaterThan(size1);
	});
});

describe("ada-write.js set-meta", () => {
	it("merges a JSON patch into the artifact", () => {
		runScript(["track-input", "patch-target", "Patch target"], "init");

		runScript(["set-meta", "patch-target", JSON.stringify({ first_input_tokens: 5555 })]);

		const a = readArtifact("patch-target");
		expect(a!.first_input_tokens).toBe(5555);
		expect(a!.inputs).toHaveLength(1);
	});

	it("does nothing when artifact is missing", () => {
		runScript(["set-meta", "ghost", JSON.stringify({ first_input_tokens: 1 })]);
		expect(readArtifact("ghost")).toBeNull();
	});

	it("bumps updated_at when patch is empty", () => {
		runScript(["track-input", "bump-only", "Bump"], "x");
		const before = readArtifact("bump-only")!.updated_at;

		const wait = Date.now() + 30;
		while (Date.now() < wait) {  }

		runScript(["set-meta", "bump-only", "{}"]);
		const after = readArtifact("bump-only")!.updated_at;

		expect(after).not.toBe(before);
	});
});

describe("ada-write.js cleanup-old", () => {
	it("removes artifacts older than the cutoff", () => {
		const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		seedArtifact({
			id: "stale",
			title: "Stale",
			type: "general",
			created_at: oldDate,
			updated_at: oldDate,
			size_bytes: 0,
			first_input_tokens: null,
			cursor: { last_processed_entry_id: null },
			data: {},
			inputs: [],
			checkpoints: [],
		}, "20260101");

		runScript(["track-input", "fresh", "Fresh"], "x");

		runScript(["cleanup-old", "7"]);

		expect(readArtifact("stale", "20260101")).toBeNull();
		expect(readArtifact("fresh")).not.toBeNull();
	});

	it("keeps artifacts newer than the cutoff", () => {
		runScript(["track-input", "recent", "Recent"], "x");
		runScript(["cleanup-old", "7"]);
		expect(readArtifact("recent")).not.toBeNull();
	});
});

describe("ada-write.js concurrent writes", () => {
	it("serializes concurrent track-input calls without losing inputs", async () => {
		await Promise.all([
			Promise.resolve(runScript(["track-input", "concurrent", "C"], "a")),
			Promise.resolve(runScript(["track-input", "concurrent", "C"], "b")),
			Promise.resolve(runScript(["track-input", "concurrent", "C"], "c")),
			Promise.resolve(runScript(["track-input", "concurrent", "C"], "d")),
		]);

		const a = readArtifact("concurrent");
		expect(a!.inputs).toHaveLength(4);
		const contents = a!.inputs.map((i) => i.content);
		expect(contents).toContain("a");
		expect(contents).toContain("b");
		expect(contents).toContain("c");
		expect(contents).toContain("d");
	});
});

describe("ada-write.js error handling", () => {
	it("exits non-zero on unknown subcommand", () => {
		expect(() => execFileSync("node", [SCRIPT, "bogus"], {
			env: { ...process.env, HOME: TMP_HOME },
			stdio: ["ignore", "ignore", "pipe"],
		})).toThrow();
	});
});
