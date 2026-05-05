import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact } from "./types.js";
import { ADA_ROOT } from "./types.js";
import { artifactDir, promoteTemporaryArtifact } from "./helpers.js";

const DEBUG_LOG = join(ADA_ROOT, "debug.log");
const DEBUG_LOG_MAX_BYTES = 1_000_000;

function debugLog(line: string): void {
	try {
		if (!existsSync(ADA_ROOT)) mkdirSync(ADA_ROOT, { recursive: true });
		if (existsSync(DEBUG_LOG)) {
			const size = statSync(DEBUG_LOG).size;
			if (size > DEBUG_LOG_MAX_BYTES) {
				const keep = readFileSync(DEBUG_LOG, "utf-8").slice(-200_000);
				writeFileSync(DEBUG_LOG, keep, "utf-8");
			}
		}
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`, "utf-8");
	} catch {  }
}

function openDebugLogFd(): number | null {
	try {
		if (!existsSync(ADA_ROOT)) mkdirSync(ADA_ROOT, { recursive: true });
		return openSync(DEBUG_LOG, "a");
	} catch { return null; }
}

const MAX_INLINE_PROMPT_BYTES = 500_000;

let cachedTemplate: string | null = null;
function loadPromptTemplate(): string {
	if (cachedTemplate !== null) return cachedTemplate;
	const here = dirname(fileURLToPath(import.meta.url));
	const path = join(here, "prompts", "extract-prompt.md");
	cachedTemplate = readFileSync(path, "utf-8");
	return cachedTemplate;
}

function scriptPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "scripts", "ada-write.js");
}

function detachedSpawn(label: string, cmd: string, args: string[], stdinPayload?: string, onExit?: () => void): void {
	try {
		debugLog(`[${label}] spawn: ${cmd} ${args.slice(0, 6).join(" ")}${args.length > 6 ? " ..." : ""}`);
		const errFd = openDebugLogFd();
		const stdio: ("ignore" | "pipe" | number)[] = stdinPayload !== undefined
			? ["pipe", "ignore", errFd ?? "ignore"]
			: ["ignore", "ignore", errFd ?? "ignore"];
		const child = spawn(cmd, args, {
			detached: true,
			stdio,
			env: { ...process.env, ADA_SUBPROCESS: "1" },
		});
		child.on("error", (e) => debugLog(`[${label}] spawn error: ${e.message}`));
		child.on("exit", (code, signal) => {
			debugLog(`[${label}] exit code=${code} signal=${signal ?? "none"}`);
			if (code === 0) {
				try { onExit?.(); } catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					debugLog(`[${label}] onExit error: ${msg}`);
				}
			}
		});
		if (stdinPayload !== undefined && child.stdin) {
			child.stdin.on("error", (e) => debugLog(`[${label}] stdin error: ${e.message}`));
			child.stdin.end(stdinPayload);
		}
		child.unref();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		debugLog(`[${label}] threw: ${msg}`);
	}
}

export function spawnTrackInput(id: string, title: string, userInput: string): void {
	debugLog(`track-input id=${id} input_len=${userInput.length}`);
	detachedSpawn("track-input", "node", [scriptPath(), "track-input", id, title], userInput);
}

export function spawnSetMeta(id: string, patch: Record<string, unknown>): void {
	debugLog(`set-meta id=${id} patch=${JSON.stringify(patch)}`);
	detachedSpawn("set-meta", "node", [scriptPath(), "set-meta", id, JSON.stringify(patch)]);
}

export function spawnCleanupOld(maxAgeDays: number): void {
	debugLog(`cleanup-old days=${maxAgeDays}`);
	detachedSpawn("cleanup-old", "node", [scriptPath(), "cleanup-old", String(maxAgeDays)]);
}

export function buildExtractPrompt(artifact: Artifact, payload: string): string {
	const template = loadPromptTemplate();
	const artifactPath = join(artifactDir(artifact.id), "artifact.json");
	const body = `file: ${artifactPath}\npayload:\n${payload}\n`;
	const full = `${template}\n${body}`;
	if (full.length <= MAX_INLINE_PROMPT_BYTES) return full;
	const overflow = full.length - MAX_INLINE_PROMPT_BYTES;
	const trimmed = payload.length > overflow + 100
		? payload.slice(0, payload.length - overflow - 100) + "\n[truncated]"
		: payload.slice(0, 1000) + "\n[truncated]";
	return `${template}\nfile: ${artifactPath}\npayload:\n${trimmed}\n`;
}

function expandHome(token: string): string {
	if (token === "~") return process.env.HOME ?? "~";
	if (token.startsWith("~/")) return `${process.env.HOME ?? "~"}${token.slice(1)}`;
	return token;
}

export function buildResponseParserArgv(command: string, promptText: string): string[] | null {
	const argv = command.trim().split(/\s+/).filter(Boolean).map(expandHome);
	if (argv.length === 0) return null;
	const args: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") {
			if (i + 1 < argv.length) i++;
			continue;
		}
		args.push(arg);
	}
	return [...args, "-p", promptText];
}

export function spawnResponseParser(artifact: Artifact, payload: string, command: string, onArtifactUpdated?: (artifact: Artifact) => void): void {
	const promptText = buildExtractPrompt(artifact, payload);
	const argv = buildResponseParserArgv(command, promptText);
	if (!argv) {
		debugLog(`response-parser skipped: empty command`);
		return;
	}
	const head = command.trim().split(/\s+/).filter(Boolean)[0];
	debugLog(`response-parser id=${artifact.id} prompt_len=${promptText.length}`);
	detachedSpawn("response-parser", head, argv, undefined, () => {
		const updated = promoteTemporaryArtifact(artifact.id);
		if (updated) onArtifactUpdated?.(updated);
	});
}

interface AgentMessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	details?: unknown;
	isError?: boolean;
}

const MAX_ASSISTANT_BLOCK_CHARS = 8_000;
const MAX_THINKING_BLOCK_CHARS = 8_000;
const MAX_TOOL_CALL_BLOCK_CHARS = 20_000;
const MAX_TOOL_RESULT_BLOCK_CHARS = 100_000;
const MAX_TOOL_DETAILS_BLOCK_CHARS = 50_000;

function isNoise(text: string): boolean {
	const normalized = text.toLowerCase();
	return text.includes("[BACKGROUND STATE -- not the conversation topic]") ||
		normalized.includes("# memory bank context") ||
		normalized.includes("## active projects") ||
		normalized.includes("## daily context") ||
		normalized.includes("## relevant knowledge") ||
		normalized.includes("active artifact:") ||
		normalized.includes("use ada_get with specific key names") ||
		normalized.includes("message delivered to comms panel");
}

function limitBlock(text: string, maxChars: number): string {
	const clean = text.trim();
	if (!clean || isNoise(clean)) return "";
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars)}\n[truncated]`;
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function imageMetadata(block: Record<string, unknown>): string {
	const mimeType = typeof block.mimeType === "string" ? block.mimeType : typeof block.mediaType === "string" ? block.mediaType : undefined;
	const data = typeof block.data === "string" ? block.data : undefined;
	const source = block.source && typeof block.source === "object" ? block.source as Record<string, unknown> : undefined;
	const sourceData = typeof source?.data === "string" ? source.data : undefined;
	return jsonText({ type: "image", mimeType, bytes: (data ?? sourceData)?.length ?? null });
}

function contentToText(content: unknown, source: "assistant" | "toolResult"): string {
	const plainLimit = source === "toolResult" ? MAX_TOOL_RESULT_BLOCK_CHARS : MAX_ASSISTANT_BLOCK_CHARS;
	if (typeof content === "string") return limitBlock(content, plainLimit);
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) parts.push(limitBlock(`[thinking]\n${b.thinking}`, MAX_THINKING_BLOCK_CHARS));
			if (b.type === "text" && typeof b.text === "string") {
				const prefix = source === "toolResult" ? "" : "[assistant]\n";
				parts.push(limitBlock(`${prefix}${b.text}`, plainLimit));
			}
			if (b.type === "image") parts.push(limitBlock(`[${source}_image]\n${imageMetadata(block as Record<string, unknown>)}`, MAX_ASSISTANT_BLOCK_CHARS));
			if (b.type === "toolCall" && typeof b.name === "string" && b.name !== "communicate") parts.push(limitBlock(`[tool_call:${b.name}]\n${jsonText(b.arguments)}`, MAX_TOOL_CALL_BLOCK_CHARS));
			if (b.type === "toolCall" && b.name === "communicate") {
				const args = b.arguments as { message?: unknown } | undefined;
				if (typeof args?.message === "string") parts.push(limitBlock(`[assistant_message]\n${args.message}`, MAX_ASSISTANT_BLOCK_CHARS));
			}
		}
		return parts.filter(Boolean).join("\n\n");
	}
	return "";
}

function hasDetails(details: unknown): boolean {
	if (details === undefined || details === null) return false;
	if (Array.isArray(details)) return details.length > 0;
	if (typeof details === "object") return Object.keys(details as Record<string, unknown>).length > 0;
	return true;
}

function toolResultToText(message: AgentMessageLike): string {
	const toolName = message.toolName ?? "unknown";
	const parts: string[] = [];
	const content = contentToText(message.content, "toolResult");
	if (content) parts.push(`[tool_result:${toolName}]\n${content}`);
	if (hasDetails(message.details)) {
		const details = limitBlock(jsonText(message.details), MAX_TOOL_DETAILS_BLOCK_CHARS);
		if (details) parts.push(`[tool_result_details:${toolName}]\n${details}`);
	}
	if (message.toolCallId || typeof message.isError === "boolean") {
		const meta = limitBlock(jsonText({ toolCallId: message.toolCallId, isError: message.isError }), MAX_TOOL_DETAILS_BLOCK_CHARS);
		if (meta) parts.push(`[tool_result_meta:${toolName}]\n${meta}`);
	}
	return parts.join("\n\n");
}

function lastTurnStart(messages: readonly AgentMessageLike[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i + 1;
	}
	return 0;
}

export function turnExtractionPayload(messages: readonly AgentMessageLike[]): string {
	const parts: string[] = [];
	for (const m of messages.slice(lastTurnStart(messages))) {
		if (m.role === "assistant") {
			const text = contentToText(m.content, "assistant");
			if (text) parts.push(text);
		}
		if (m.role === "toolResult") {
			const text = toolResultToText(m);
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n");
}

export const lastAssistantText = turnExtractionPayload;
