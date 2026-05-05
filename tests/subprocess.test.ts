import { describe, expect, it } from "vitest";
import { buildExtractPrompt, buildResponseParserArgv, turnExtractionPayload } from "../subprocess.js";
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

describe("turnExtractionPayload", () => {
	it("returns empty string when there are no assistant messages", () => {
		expect(turnExtractionPayload([])).toBe("");
		expect(turnExtractionPayload([{ role: "user", content: "hi" }])).toBe("");
	});

	it("returns the last assistant message text", () => {
		const out = turnExtractionPayload([
			{ role: "user", content: "go" },
			{ role: "assistant", content: "first" },
			{ role: "user", content: "again" },
			{ role: "assistant", content: "final" },
		]);
		expect(out).toBe("final");
	});

	it("flattens visible thinking and text blocks", () => {
		const out = turnExtractionPayload([
			{ role: "assistant", content: [{ type: "thinking", thinking: "thinking 1" }, { type: "text", text: "line 1" }, { type: "text", text: "line 2" }, { type: "tool_use" }] },
		]);
		expect(out).toBe("[thinking]\nthinking 1\n\n[assistant]\nline 1\n\n[assistant]\nline 2");
	});

	it("includes communicate tool call messages without tool call noise", () => {
		const out = turnExtractionPayload([
			{ role: "assistant", content: [{ type: "toolCall", name: "communicate", arguments: { message: "visible response" } }] },
		]);
		expect(out).toBe("[assistant_message]\nvisible response");
	});

	it("includes tool results", () => {
		const out = turnExtractionPayload([
			{ role: "assistant", content: "before tools" },
			{ role: "toolUse", content: "ignored" },
			{ role: "toolResult", toolName: "bash", content: "command output" },
		]);
		expect(out).toBe("before tools\n\n[tool_result:bash]\ncommand output");
	});

	it("handles Pi-shaped tool result content arrays without assistant labels", () => {
		const out = turnExtractionPayload([
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "fetched data" }] },
		]);
		expect(out).toBe("[tool_result:read]\nfetched data");
		expect(out).not.toContain("[assistant]");
	});

	it("includes tool result details", () => {
		const out = turnExtractionPayload([
			{ role: "toolResult", toolName: "bash", content: "short output", details: { truncation: { truncated: true }, fullOutputPath: "/path/full.log" } },
		]);
		expect(out).toContain("[tool_result:bash]\nshort output");
		expect(out).toContain("[tool_result_details:bash]");
		expect(out).toContain('"truncated": true');
		expect(out).toContain('"fullOutputPath": "/path/full.log"');
	});

	it("keeps fetched data omitted from final prose", () => {
		const out = turnExtractionPayload([
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "facts.txt" } }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "secret fact: checkout_token=abc" }] },
			{ role: "assistant", content: [{ type: "text", text: "I checked the file." }] },
		]);
		expect(out).toContain("[tool_call:read]");
		expect(out).toContain("secret fact: checkout_token=abc");
		expect(out).toContain("[assistant]\nI checked the file.");
	});

	it("keeps thinking, tool calls, tool results, and final text in one turn", () => {
		const out = turnExtractionPayload([
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "maybe query observe" },
				{ type: "toolCall", name: "observe_query", arguments: { query: "errors" } },
			] },
			{ role: "toolResult", toolName: "observe_query", content: [{ type: "text", text: "5 errors" }] },
			{ role: "assistant", content: [{ type: "text", text: "Found errors." }] },
		]);
		expect(out).toContain("[thinking]\nmaybe query observe");
		expect(out).toContain("[tool_call:observe_query]");
		expect(out).toContain("[tool_result:observe_query]\n5 errors");
		expect(out).toContain("[assistant]\nFound errors.");
	});

	it("keeps long tool results beyond the old 4000 character boundary", () => {
		const longResult = "x".repeat(10_000);
		const out = turnExtractionPayload([
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: longResult }] },
		]);
		expect(out).toContain("x".repeat(8_000));
		expect(out).not.toContain("[truncated]");
	});

	it("drops ADA and memory-bank context noise", () => {
		const out = turnExtractionPayload([
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
