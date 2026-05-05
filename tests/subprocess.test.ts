import { describe, expect, it } from "vitest";
import { buildExtractPrompt, buildResponseParserArgv, lastAssistantText } from "../subprocess.js";
import type { Artifact } from "../types.js";

function makeArtifact(id = "art-1"): Artifact {
	return {
		id,
		title: "x",
		type: "general",
		created_at: "2026-05-04T10:00:00-04:00",
		updated_at: "2026-05-04T10:00:00-04:00",
		size_bytes: 0,
		first_input_tokens: null,
		cursor: { last_processed_entry_id: null },
		data: {},
		checkpoints: [],
	};
}

describe("lastAssistantText", () => {
	it("returns empty string when there are no assistant messages", () => {
		expect(lastAssistantText([])).toBe("");
		expect(lastAssistantText([{ role: "user", content: "hi" }])).toBe("");
	});

	it("returns the last assistant message text", () => {
		const out = lastAssistantText([
			{ role: "user", content: "go" },
			{ role: "assistant", content: "first" },
			{ role: "user", content: "again" },
			{ role: "assistant", content: "final" },
		]);
		expect(out).toBe("final");
	});

	it("flattens visible thinking and text blocks", () => {
		const out = lastAssistantText([
			{ role: "assistant", content: [{ type: "thinking", thinking: "thinking 1" }, { type: "text", text: "line 1" }, { type: "text", text: "line 2" }, { type: "tool_use" }] },
		]);
		expect(out).toBe("[thinking]\nthinking 1\n\n[assistant]\nline 1\n\n[assistant]\nline 2");
	});

	it("includes communicate tool call messages without tool call noise", () => {
		const out = lastAssistantText([
			{ role: "assistant", content: [{ type: "toolCall", name: "communicate", arguments: { message: "visible response" } }] },
		]);
		expect(out).toBe("[assistant_message]\nvisible response");
	});

	it("includes tool results", () => {
		const out = lastAssistantText([
			{ role: "assistant", content: "before tools" },
			{ role: "toolUse", content: "ignored" },
			{ role: "toolResult", toolName: "bash", content: "command output" },
		]);
		expect(out).toBe("before tools\n\n[tool_result:bash]\ncommand output");
	});

	it("drops ADA and memory-bank context noise", () => {
		const out = lastAssistantText([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [
				{ type: "text", text: "[BACKGROUND STATE -- not the conversation topic]\nActive artifact: x\nUse ada_get with specific key names above to load data when needed." },
				{ type: "toolCall", name: "communicate", arguments: { message: "Message delivered to comms panel." } },
				{ type: "text", text: "real work happened" },
			] },
			{ role: "toolResult", toolName: "read", content: "## Active Projects\nP0 garbage" },
		]);
		expect(out).toBe("[assistant]\nreal work happened");
	});
});

describe("buildExtractPrompt", () => {
	it("includes the artifact file and payload block", () => {
		const out = buildExtractPrompt(makeArtifact("my-id"), "hello world");
		expect(out).toMatch(/file: .+\/my-id\/artifact\.json/);
		expect(out).toContain("payload:\nhello world");
	});

	it("starts with the bundled prompt template", () => {
		const out = buildExtractPrompt(makeArtifact(), "x");
		expect(out.startsWith("You're a data extraction expert agent")).toBe(true);
	});

	it("truncates the assistant block when the prompt exceeds the cap", () => {
		const huge = "x".repeat(600_000);
		const out = buildExtractPrompt(makeArtifact(), huge);
		expect(out.length).toBeLessThanOrEqual(500_000);
		expect(out).toContain("[truncated]");
	});
});

describe("buildResponseParserArgv", () => {
	it("returns null for empty commands", () => {
		expect(buildResponseParserArgv("", "prompt")).toBeNull();
		expect(buildResponseParserArgv("   ", "prompt")).toBeNull();
	});

	it("appends -p and the prompt from the configured command", () => {
		const out = buildResponseParserArgv("pi --no-session --model anthropic/claude-haiku-4-5", "PROMPT_TEXT");
		expect(out).toEqual(["--no-session", "--model", "anthropic/claude-haiku-4-5", "-p", "PROMPT_TEXT"]);
	});

	it("strips existing print args before appending the real prompt", () => {
		const out = buildResponseParserArgv("pi --no-session -p ignored", "REAL");
		expect(out).toEqual(["--no-session", "-p", "REAL"]);
	});

	it("does not secretly add --no-session when the configured command omits it", () => {
		const out = buildResponseParserArgv("pi --thinking off --model x/y", "P");
		expect(out).toEqual(["--thinking", "off", "--model", "x/y", "-p", "P"]);
	});

	it("handles multi-token commands without shell interpretation", () => {
		const out = buildResponseParserArgv("pi --no-session --thinking off --model x/y", "P");
		expect(out).toEqual(["--no-session", "--thinking", "off", "--model", "x/y", "-p", "P"]);
	});
});
