/**
 * ADA — Artifact Driven Agent
 *
 * Extension that maintains structured JSON artifacts during iterative work.
 * When the agent is doing anything multi-step — performance investigations,
 * bug fixes, code reviews, planning — it creates an artifact that serves as
 * the source of truth for the entire conversation.
 *
 * Artifacts are shared across sessions. Any session can resume any artifact
 * via /ada-resume. There is no session binding or lifecycle status.
 * Spawned agents can only read/update — never create.
 *
 * Files:
 *   index.ts   — state, event handlers, wiring
 *   tools.ts   — tool definitions
 *   helpers.ts — disk I/O, persistence, cleanup
 *   types.ts   — all type definitions
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	cleanupOldArtifacts,
	listArtifactsFromDisk,
	readArtifactFromDisk,
	writeArtifactToDisk,
	persistState,
} from "./helpers.js";
import { registerTools } from "./tools.js";
import type { ADAState, Artifact } from "./types.js";
import { ARTIFACTS_DIR } from "./types.js";

/** Tool names considered "substantive" for nudge heuristic. */
const SUBSTANTIVE_TOOLS = new Set([
	"bash", "read", "edit", "write",
	"grokt_search", "grokt_bulk_search", "grokt_get_file",
	"observe_query", "observe_events_by_id", "observe_trace",
	"data_portal_query_bigquery",
	"run_experiment",
	"scan_test_gaps", "design_test_cases", "validate_test_value",
]);

/** Minimum substantive tool calls before nudging. */
const NUDGE_THRESHOLD = 4;

export default function adaExtension(pi: ExtensionAPI): void {
	// ─── Spawned Agent Detection ───────────────────────────────────
	// Spawned agents can only read/update artifacts. Never create.
	// They get the artifact ID in their task prompt from the lead.
	const isSpawnedAgent = process.env.PI_AGENT_ROLE === "subagent" ||
		process.env.PI_TEAM_NAME !== undefined;

	const state: ADAState = {
		artifact: null,
		artifactUpdatedThisTurn: false,
		toolCallsThisTurn: 0,
	};

	// ─── State Restoration ──────────────────────────────────────────

	function restoreState(ctx: ExtensionContext): void {
		state.artifact = null;
		state.artifactUpdatedThisTurn = false;
		state.toolCallsThisTurn = 0;

		// Restore from session branch. Artifacts are shared — no session binding.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "ada-artifact") {
				const data = entry.data as { artifact?: { id: string } } | undefined;
				if (data?.artifact) {
					state.artifact = readArtifactFromDisk(data.artifact.id);
				} else {
					state.artifact = null;
				}
			}

			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "ada_create" &&
				entry.message.details?.artifact
			) {
				const a = entry.message.details.artifact as Artifact;
				state.artifact = readArtifactFromDisk(a.id);
			}
		}

		// Auto-cleanup old artifacts on session start
		cleanupOldArtifacts(7);
	}

	// ─── Session Events ─────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	// ─── System Prompt Injection ────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (isSpawnedAgent) return; // Spawned agents get tools, not prompt injection
		if (!state.artifact) return;

		// Re-read from disk to get the latest keys (another agent may have written)
		const fresh = readArtifactFromDisk(state.artifact.id);
		if (fresh) {
			state.artifact.data = fresh.data;
			state.artifact.checkpoints = fresh.checkpoints;
		}

		const a = state.artifact;
		const dataKeys = Object.keys(a.data);
		const cpCount = a.checkpoints.length;
		const lastCp = cpCount > 0 ? a.checkpoints[cpCount - 1].note : null;

		// Build a concise context block so the agent never has to guess key names.
		// This eliminates the common pattern of ada_get with wrong keys -> header -> correct key.
		let keysLine = "";
		if (dataKeys.length > 0) {
			keysLine = `\nData keys (${dataKeys.length}): ${dataKeys.join(", ")}`;
		}
		let cpLine = "";
		if (lastCp) {
			cpLine = `\nLast checkpoint (#${cpCount}): ${lastCp}`;
		}

		return {
			systemPrompt: undefined,
			message: {
				customType: "ada-context",
				content: `[BACKGROUND STATE -- not the conversation topic]
Active artifact: "${a.title}" (${a.type}) -- ${a.id}${keysLine}${cpLine}
Use ada_get with specific key names above to load data when needed.`,
				display: false,
			},
		};
	});

	// ─── Nudge Tracking ─────────────────────────────────────────────

	pi.on("turn_start", async () => {
		state.artifactUpdatedThisTurn = false;
		state.toolCallsThisTurn = 0;
	});

	pi.on("tool_execution_end", async (event) => {
		if (
			event.toolName === "ada_create" ||
			event.toolName === "ada_update" ||
			event.toolName === "ada_checkpoint"
		) {
			state.artifactUpdatedThisTurn = true;
		} else if (SUBSTANTIVE_TOOLS.has(event.toolName)) {
			state.toolCallsThisTurn++;
		}
	});

	pi.on("agent_end", async () => {
		if (!state.artifact) return;
		if (state.artifactUpdatedThisTurn) return;
		if (state.toolCallsThisTurn < NUDGE_THRESHOLD) return;

		pi.sendMessage(
			{
				customType: "ada-nudge",
				content: `You made ${state.toolCallsThisTurn} tool calls this turn but didn't update the artifact. Consider using ada_update to log what you found or decided.`,
				display: true,
			},
			{ triggerTurn: false },
		);
	});

	// ─── Context Message Filtering ──────────────────────────────────

	pi.on("context", async (event) => {
		let lastContextIdx = -1;
		const messages = event.messages;

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as typeof messages[number] & { customType?: string };
			if (msg.customType === "ada-context") {
				lastContextIdx = i;
				break;
			}
		}

		return {
			messages: messages.filter((m, i) => {
				const msg = m as typeof m & { customType?: string };
				if (msg.customType === "ada-nudge") return false;
				if (msg.customType === "ada-context" && i !== lastContextIdx) return false;
				return true;
			}),
		};
	});

	// ─── /artifact Command ──────────────────────────────────────────

	pi.registerCommand("ada-list", {
		description: "List all ADA artifacts",
		handler: async (_args, ctx) => {
			const all = listArtifactsFromDisk();
			if (all.length === 0) {
				ctx.ui.notify("No artifacts found.", "info");
				return;
			}
			const currentId = state.artifact?.id;
			const lines = all.map((a) => {
				const active = a.id === currentId ? " [current]" : "";
				const age = timeSince(new Date(a.updated_at));
				const dataKeys = Object.keys(a.data ?? {});
				const cpCount = (a.checkpoints ?? []).length;
				const lastCp = cpCount > 0 ? a.checkpoints[cpCount - 1].note.slice(0, 60) : "";
				return `${a.title} (${a.type}) -- ${dataKeys.length} keys, ${cpCount} cp -- ${age} ago${active}\n  ${lastCp ? `last: ${lastCp}\n  ` : ""}id: ${a.id}`;
			});
			ctx.ui.notify(lines.join("\n\n"), "info");
		},
	});

	pi.registerCommand("ada-resume", {
		description: "Resume an ADA artifact by ID or interactive picker",
		handler: async (args, ctx) => {
			let id = (args ?? "").trim();

			// No ID provided -- show interactive picker
			if (!id) {
				const all = listArtifactsFromDisk();
				const currentId = state.artifact?.id;
				const resumable = all.filter((a) => a.id !== currentId);
				if (resumable.length === 0) {
					ctx.ui.notify("No other artifacts to resume.", "info");
					return;
				}
				const options = resumable.map((a) => {
					const age = timeSince(new Date(a.updated_at));
					return `${a.title} (${Object.keys(a.data ?? {}).length} keys, ${age} ago) -- ${a.id}`;
				});
				const choice = await ctx.ui.select("Resume artifact:", options);
				if (!choice) return;
				const match = choice.match(/-- (.+)$/);
				if (!match) return;
				id = match[1];
			}

			const artifact = readArtifactFromDisk(id);
			if (!artifact) {
				ctx.ui.notify(`Artifact not found: ${id}`, "error");
				return;
			}

			// Detach current artifact if one exists, then switch
			if (state.artifact) {
				state.artifact.updated_at = new Date().toISOString();
				writeArtifactToDisk(state.artifact);
			}

			artifact.updated_at = new Date().toISOString();
			state.artifact = artifact;
			writeArtifactToDisk(artifact);
			persistState(pi, state);

			const dataKeys = Object.keys(artifact.data ?? {});
			const cpCount = (artifact.checkpoints ?? []).length;
			ctx.ui.notify(`Resumed: "${artifact.title}" (${dataKeys.length} keys, ${cpCount} checkpoints)`, "info");

			// Inject a context message with the keys so the agent knows what data
			// is available without having to call ada_get(header) first.
			const lastCp = cpCount > 0 ? artifact.checkpoints[cpCount - 1].note : null;
			let keysLine = "";
			if (dataKeys.length > 0) {
				keysLine = `\nData keys (${dataKeys.length}): ${dataKeys.join(", ")}`;
			}
			let cpLine = "";
			if (lastCp) {
				cpLine = `\nLast checkpoint (#${cpCount}): ${lastCp}`;
			}
			pi.sendMessage(
				{
					customType: "ada-context",
					content: `[BACKGROUND STATE -- not the conversation topic]
Resumed artifact: "${artifact.title}" (${artifact.type}) -- ${artifact.id}${keysLine}${cpLine}
Use ada_get with specific key names above to load data when needed.`,
					display: false,
				},
				{ triggerTurn: false },
			);
		},
	});

	// ─── Artifact Injection into team_spawn ────────────────────────
	// When the lead spawns a teammate while an artifact is active, append
	// the artifact ID to the task so the spawned agent auto-connects.
	// This is the explicit handoff — no guessing, no disk scanning.

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "team_spawn") return;
		if (!state.artifact) return;
		if (isSpawnedAgent) return; // only leads inject

		const input = event.input as { task?: string };
		if (!input.task) return;

		const artifactId = state.artifact.id;
		const dir = `${ARTIFACTS_DIR}/${artifactId}`;
		const dataKeys = Object.keys(state.artifact.data);
		const keysInfo = dataKeys.length > 0
			? `\nAvailable data keys: ${dataKeys.join(", ")}`
			: "";
		input.task += `\n\nActive ADA artifact: ${artifactId}\n` +
			`Artifact folder: ${dir}/\n` +
			`Use ada_get with id="${artifactId}" to connect, then ada_update to write findings.` +
			keysInfo;
	});

	// ─── Register Tools ─────────────────────────────────────────────

	registerTools(pi, state, isSpawnedAgent);
}

// ─── Utility ──────────────────────────────────────────────────────────

function timeSince(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
