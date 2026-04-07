/**
 * ADA — Artifact Driven Agent
 *
 * Extension that maintains structured JSON artifacts during iterative work.
 * When the agent is doing anything multi-step — performance investigations,
 * bug fixes, code reviews, planning — it creates an artifact that serves as
 * the source of truth for the entire conversation.
 *
 * CRITICAL INVARIANT: Artifacts NEVER leak across sessions. Every path that
 * loads an artifact into state checks session_id against the current session.
 * The only way to load another session's artifact is explicit /artifact resume.
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
	// ─── Session vs Spawned Agent ───────────────────────────────────
	// Spawned agents (team_spawn) are part of the SAME session -- they get
	// full artifact access (tools + reads + writes). They are teammates.
	// Different Pi sessions are what session binding prevents.
	// Spawned agents skip prompt injection only (they get the artifact ID
	// in their task prompt from the lead, not via auto-injection).
	const isSpawnedAgent = process.env.PI_AGENT_ROLE === "subagent" ||
		process.env.PI_TEAM_NAME !== undefined;

	const state: ADAState = {
		artifact: null,
		artifactUpdatedThisTurn: false,
		toolCallsThisTurn: 0,
		sessionId: null,
	};

	// ─── Session-Guarded Artifact Loading ───────────────────────────
	// This is the ONLY function that may set state.artifact from disk.
	// It enforces session_id matching. No exceptions.

	function loadArtifactIfOwned(id: string): Artifact | null {
		const artifact = readArtifactFromDisk(id);
		if (!artifact) return null;
		// Spawned agents are trusted teammates -- they skip session binding.
		// They are told which artifact to use by the lead in their task prompt.
		if (isSpawnedAgent) return artifact;
		// Session binding: only load if this session owns it.
		// Reject if we don't know our own session yet, or if the artifact
		// belongs to a different session.
		if (!state.sessionId) return null;
		if (artifact.session_id && artifact.session_id !== state.sessionId) {
			return null;
		}
		return artifact;
	}

	// ─── State Restoration ──────────────────────────────────────────

	function restoreState(ctx: ExtensionContext): void {
		state.artifact = null;
		state.artifactUpdatedThisTurn = false;
		state.toolCallsThisTurn = 0;
		state.sessionId = ctx.sessionManager.getSessionFile() ?? null;

		// Restore ONLY from session branch. No disk fallback. Ever.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "ada-artifact") {
				const data = entry.data as { artifact?: { id: string; status: string } } | undefined;
				if (data?.artifact) {
					state.artifact = loadArtifactIfOwned(data.artifact.id);
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
				state.artifact = loadArtifactIfOwned(a.id);
			}

			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "ada_close" &&
				entry.message.details?.artifact
			) {
				const a = entry.message.details.artifact as Artifact;
				if (a.status === "completed") {
					state.artifact = null;
				}
			}
		}

		// Auto-cleanup old completed artifacts on session start
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
		if (!state.artifact || state.artifact.status !== "active") return;

		const a = state.artifact;

		return {
			systemPrompt: undefined,
			message: {
				customType: "ada-context",
				content: `[BACKGROUND STATE -- not the conversation topic]
Active artifact: "${a.title}" (${a.type}) -- ${a.id}
Use ada_get to load specific data when needed.`,
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
			event.toolName === "ada_checkpoint" ||
			event.toolName === "ada_close"
		) {
			state.artifactUpdatedThisTurn = true;
		} else if (SUBSTANTIVE_TOOLS.has(event.toolName)) {
			state.toolCallsThisTurn++;
		}
	});

	pi.on("agent_end", async () => {
		if (!state.artifact || state.artifact.status !== "active") return;
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
			const lines = all.map((a) => {
				const statusLabel = a.status === "active" ? "[active]" : a.status === "paused" ? "[paused]" : "[done]";
				const owned = a.session_id === state.sessionId ? "" : " [other session]";
				const age = timeSince(new Date(a.updated_at));
				const dataKeys = Object.keys(a.data ?? {});
				const cpCount = (a.checkpoints ?? []).length;
				const lastCp = cpCount > 0 ? a.checkpoints[cpCount - 1].note.slice(0, 60) : "";
				return `${statusLabel} ${a.title} (${a.type}) -- ${dataKeys.length} keys, ${cpCount} cp -- ${age} ago${owned}\n  ${lastCp ? `last: ${lastCp}\n  ` : ""}id: ${a.id}`;
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
				const resumable = all.filter((a) => a.status !== "active" || a.session_id !== state.sessionId);
				if (resumable.length === 0) {
					ctx.ui.notify("No artifacts to resume.", "info");
					return;
				}
				const options = resumable.map((a) => {
					const label = a.status === "paused" ? "[paused]" : a.status === "completed" ? "[done]" : "[active]";
					const age = timeSince(new Date(a.updated_at));
					return `${label} ${a.title} (${Object.keys(a.data ?? {}).length} keys, ${age} ago) -- ${a.id}`;
				});
				const choice = await ctx.ui.select("Resume artifact:", options);
				if (!choice) return;
				// Extract ID from the end of the selected line
				const match = choice.match(/-- (.+)$/);
				if (!match) return;
				id = match[1];
			}

			const artifact = readArtifactFromDisk(id);
			if (!artifact) {
				ctx.ui.notify(`Artifact not found: ${id}`, "error");
				return;
			}
			if (state.artifact?.status === "active") {
				ctx.ui.notify(`Close the current artifact first: "${state.artifact.title}"`, "warn");
				return;
			}
			artifact.status = "active";
			artifact.session_id = state.sessionId;
			artifact.updated_at = new Date().toISOString();
			state.artifact = artifact;
			writeArtifactToDisk(artifact);
			persistState(pi, state);
			ctx.ui.notify(`Resumed: "${artifact.title}" (${Object.keys(artifact.data ?? {}).length} keys, ${(artifact.checkpoints ?? []).length} checkpoints)`, "info");
		},
	});

	// ─── Artifact Injection into team_spawn ────────────────────────
	// When the lead spawns a teammate while an artifact is active, append
	// the artifact ID to the task so the spawned agent auto-connects.
	// This is the explicit handoff — no guessing, no disk scanning.

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "team_spawn") return;
		if (!state.artifact || state.artifact.status !== "active") return;
		if (isSpawnedAgent) return; // only leads inject

		const input = event.input as { task?: string };
		if (!input.task) return;

		const artifactId = state.artifact.id;
		const dir = `${ARTIFACTS_DIR}/${artifactId}`;
		input.task += `\n\nActive ADA artifact: ${artifactId}\n` +
			`Artifact folder: ${dir}/\n` +
			`Use ada_get with id="${artifactId}" to connect, then ada_update to write findings.`;
	});

	// ─── Register Tools ─────────────────────────────────────────────

	registerTools(pi, state, loadArtifactIfOwned);
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
