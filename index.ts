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
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	cleanupOldArtifacts,
	listArtifactsFromDisk,
	readArtifactFromDisk,
	writeArtifactToDisk,
	persistState,
	artifactDir,
	jewelryForComplexity,
	formatSize,
	getArtifactFileSize,
	timeSince as timeSinceDate,
} from "./helpers.js";
import { registerTools } from "./tools.js";
import type { ADAState, Artifact } from "./types.js";

const MUTATING_TOOLS = new Set(["edit", "write"]);

const READ_LIKE_TOOLS = new Set([
	"read",
	"grokt_search", "grokt_bulk_search", "grokt_get_file",
	"observe_query", "observe_events_by_id", "observe_trace", "observe_error_groups", "observe_error_group",
	"data_portal_search_data_platform", "data_portal_get_entry_metadata", "data_portal_query_bigquery", "data_portal_analyze_query_results",
	"bk_build_info", "bk_failed_jobs", "bk_job_failure", "bk_job_logs",
	"slack_search", "slack_thread", "slack_message", "slack_history", "slack_canvas",
	"gmail_read", "gcal_events", "gcal_availability",
	"gworkspace_read_file", "gdrive_search", "gsheets_read", "gdocs_get_structure",
]);

const OTHER_SUBSTANTIVE_TOOLS = new Set([
	"bash",
	"run_experiment",
	"scan_test_gaps", "design_test_cases", "validate_test_value",
]);

const READ_BATCH_THRESHOLD = 2;
const OTHER_SUBSTANTIVE_THRESHOLD = 2;

const ADA_WIDGET_KEY = "ada-artifact-banner";

export default function adaExtension(pi: ExtensionAPI): void {
	// ─── Spawned Agent Detection ───────────────────────────────────
	// Spawned agents can only read/update artifacts. Never create.
	// They get the artifact ID in their task prompt from the lead.
	const isSpawnedAgent = process.env.PI_AGENT_ROLE === "subagent" ||
		process.env.PI_TEAM_NAME !== undefined;

	const state: ADAState = {
		artifact: null,
		mutatingToolsSinceCheckpoint: [],
		readLikeToolsSinceCheckpoint: 0,
		otherSubstantiveToolsSinceCheckpoint: 0,
	};

	let currentCtx: ExtensionContext | null = null;

	// ─── Artifact Banner (widget above editor) ───────────────────────
	// Shows:
	//   ─────────────────────────────────────────────
	//     <jewelry>  │  <title>  │  <size>  │  <updated>
	//   ─────────────────────────────────────────────

	function updateBanner(ctx?: ExtensionContext): void {
		const c = ctx ?? currentCtx;
		if (!c?.hasUI) return;

		if (!state.artifact) {
			c.ui.setWidget(ADA_WIDGET_KEY, undefined);
			return;
		}

		const a = state.artifact;
		const dataKeys = Object.keys(a.data).length;
		const cpCount = a.checkpoints.length;
		const jewelry = jewelryForComplexity(dataKeys, cpCount);
		const size = formatSize(getArtifactFileSize(a.id));
		const updated = timeSinceDate(new Date(a.updated_at));

		c.ui.setWidget(ADA_WIDGET_KEY, (_tui, theme) => {
			return {
				render: (width: number) => {
					const sep = theme.fg("dim", " │ ");
					const content =
						`  ${jewelry} ` + sep +
						theme.fg("accent", theme.bold(a.title)) + sep +
						theme.fg("muted", size) + sep +
						theme.fg("muted", updated);
					const bar = theme.fg("dim", "─".repeat(width));
					return [bar, truncateToWidth(content, width), bar];
				},
				invalidate: () => {},
			};
		});
	}

	// ─── State Restoration ──────────────────────────────────────────

	function restoreState(ctx: ExtensionContext): void {
		state.artifact = null;
		state.mutatingToolsSinceCheckpoint = [];
		state.readLikeToolsSinceCheckpoint = 0;
		state.otherSubstantiveToolsSinceCheckpoint = 0;
		currentCtx = ctx;

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

		// Show or hide status bar based on restored state
		updateBanner(ctx);
	}

	// ─── Session Events ─────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

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
Use ada_get with specific key names above to load data when needed.
Checkpoint discipline: after edit/write, call ada_checkpoint immediately. After important reads or two read/search/query tools, call ada_checkpoint before continuing. ada_update does not replace ada_checkpoint.`,
				display: false,
			},
		};
	});

	// ─── Nudge Tracking ─────────────────────────────────────────────

	function resetCheckpointDebt(): void {
		state.mutatingToolsSinceCheckpoint = [];
		state.readLikeToolsSinceCheckpoint = 0;
		state.otherSubstantiveToolsSinceCheckpoint = 0;
	}

	pi.on("turn_start", async () => {
		resetCheckpointDebt();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "ada_checkpoint") {
			resetCheckpointDebt();
			updateBanner();
			return;
		}

		if (event.toolName === "ada_create" || event.toolName === "ada_update") {
			updateBanner();
			return;
		}

		if (!state.artifact) return;
		if (event.isError && MUTATING_TOOLS.has(event.toolName)) return;

		if (MUTATING_TOOLS.has(event.toolName)) {
			state.mutatingToolsSinceCheckpoint.push(event.toolName);
			return;
		}

		if (READ_LIKE_TOOLS.has(event.toolName)) {
			state.readLikeToolsSinceCheckpoint++;
			return;
		}

		if (OTHER_SUBSTANTIVE_TOOLS.has(event.toolName)) {
			state.otherSubstantiveToolsSinceCheckpoint++;
		}
	});

	pi.on("turn_end", async () => {
		if (!state.artifact) return;

		const reasons: string[] = [];
		if (state.mutatingToolsSinceCheckpoint.length > 0) {
			reasons.push(`edit/write tools ran: ${state.mutatingToolsSinceCheckpoint.join(", ")}`);
		}
		if (state.readLikeToolsSinceCheckpoint >= READ_BATCH_THRESHOLD) {
			reasons.push(`${state.readLikeToolsSinceCheckpoint} read/search/query tools loaded information`);
		}
		if (state.otherSubstantiveToolsSinceCheckpoint >= OTHER_SUBSTANTIVE_THRESHOLD) {
			reasons.push(`${state.otherSubstantiveToolsSinceCheckpoint} substantive tools ran`);
		}
		if (reasons.length === 0) return;

		pi.sendMessage(
			{
				customType: "ada-nudge",
				content: `[CHECKPOINT REQUIRED] ${reasons.join("; ")}. Call ada_checkpoint now before doing anything else. ` +
					`For edit/write, checkpoint the exact file change. For reads, checkpoint the important finding or batch loaded.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	// ─── Context Message Filtering ──────────────────────────────────

	pi.on("context", async (event) => {
		let lastContextIdx = -1;
		let lastNudgeIdx = -1;
		let checkpointAfterLastNudge = false;
		const messages = event.messages;

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as typeof messages[number] & { customType?: string; role?: string; toolName?: string };
			if (lastContextIdx === -1 && msg.customType === "ada-context") {
				lastContextIdx = i;
			}
			if (lastNudgeIdx === -1 && msg.customType === "ada-nudge") {
				lastNudgeIdx = i;
			}
			if (lastContextIdx !== -1 && lastNudgeIdx !== -1) break;
		}

		if (lastNudgeIdx !== -1) {
			for (let i = lastNudgeIdx + 1; i < messages.length; i++) {
				const msg = messages[i] as typeof messages[number] & { role?: string; toolName?: string };
				if (msg.role === "toolResult" && msg.toolName === "ada_checkpoint") {
					checkpointAfterLastNudge = true;
					break;
				}
			}
		}

		return {
			messages: messages.filter((m, i) => {
				const msg = m as typeof m & { customType?: string };
				if (msg.customType === "ada-nudge") return !checkpointAfterLastNudge && i === lastNudgeIdx;
				if (msg.customType === "ada-context" && i !== lastContextIdx) return false;
				return true;
			}),
		};
	});

	// ─── /ada-resume Command ─────────────────────────────────────────

	pi.registerCommand("ada-resume", {
		description: "Resume an ADA artifact by ID, interactive picker, or search (use / to search)",
		handler: async (args, ctx) => {
			let id = (args ?? "").trim();

			// "/" or "search" jumps straight to search mode
			const isSearchMode = id === "/" || id.toLowerCase() === "search";
			if (isSearchMode) id = "";

			// No ID provided -- show interactive picker with pagination + search
			if (!id) {
				const all = listArtifactsFromDisk();
				const currentId = state.artifact?.id;
				let pool = all.filter((a) => a.id !== currentId);
				if (pool.length === 0) {
					ctx.ui.notify("No other artifacts to resume.", "info");
					return;
				}

				const PAGE_SIZE = 20;
				let page = 0;
				let searchTerm = "";

				// If launched with "/" or "search", prompt for search immediately
				if (isSearchMode) {
					const term = await ctx.ui.input("Search artifacts:", "title, id, or type");
					if (!term) return;
					searchTerm = term;
				}

				picker: while (true) {
					const filtered = searchTerm
						? pool.filter((a) => {
								const hay = `${a.title} ${a.id} ${a.type}`.toLowerCase();
								return hay.includes(searchTerm.toLowerCase());
							})
						: pool;

					if (filtered.length === 0) {
						ctx.ui.notify(`No artifacts matching "${searchTerm}".`, "info");
						searchTerm = "";
						page = 0;
						continue;
					}

					const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
					if (page >= totalPages) page = totalPages - 1;
					const start = page * PAGE_SIZE;
					const slice = filtered.slice(start, start + PAGE_SIZE);

					const options: string[] = [];
					// Search/clear at the top for quick access
					options.push(searchTerm ? `[x] Clear search ("${searchTerm}")` : "[/] Search...");
					if (page > 0) options.push("<< Previous page");
					for (const a of slice) {
						const age = timeSince(new Date(a.updated_at));
						options.push(`${a.title} (${Object.keys(a.data ?? {}).length} keys, ${age} ago) -- ${a.id}`);
					}
					if (page < totalPages - 1) options.push(">> Next page");

					const label = searchTerm
						? `Resume artifact ("${searchTerm}", ${filtered.length} matches, page ${page + 1}/${totalPages}):`
						: `Resume artifact (${filtered.length} total, page ${page + 1}/${totalPages}):`;

					const choice = await ctx.ui.select(label, options);
					if (!choice) return;

					if (choice === "<< Previous page") { page--; continue; }
					if (choice === ">> Next page") { page++; continue; }
					if (choice.startsWith("[x] Clear search")) { searchTerm = ""; page = 0; continue; }
					if (choice === "[/] Search...") {
						const term = await ctx.ui.input("Search artifacts:", "title, id, or type");
						if (term) { searchTerm = term; page = 0; }
						continue;
					}

					const match = choice.match(/-- (.+)$/);
					if (!match) return;
					id = match[1];
					break picker;
				}
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
			updateBanner(ctx);

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
Use ada_get with specific key names above to load data when needed.
Checkpoint discipline: after edit/write, call ada_checkpoint immediately. After important reads or two read/search/query tools, call ada_checkpoint before continuing. ada_update does not replace ada_checkpoint.`,
					display: false,
				},
				{ triggerTurn: false },
			);
		},
	});

	// ─── /ada-inspect Command ────────────────────────────────────────

	pi.registerCommand("ada-inspect", {
		description: "Open a visual artifact inspector in the browser",
		handler: async (args, ctx) => {
			const { readFileSync, writeFileSync } = await import("node:fs");
			const { join, dirname } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const { execSync } = await import("node:child_process");

			// Determine which artifact to inspect
			let targetId = (args ?? "").trim();

			if (!targetId && state.artifact) {
				targetId = state.artifact.id;
			}

			if (!targetId) {
				// Show interactive picker with pagination + search
				const all = listArtifactsFromDisk();
				if (all.length === 0) {
					ctx.ui.notify("No artifacts to inspect.", "info");
					return;
				}

				const PAGE_SIZE = 20;
				let page = 0;
				let searchTerm = "";

				picker: while (true) {
					const filtered = searchTerm
						? all.filter((a) => {
								const hay = `${a.title} ${a.id} ${a.type}`.toLowerCase();
								return hay.includes(searchTerm.toLowerCase());
							})
						: all;

					if (filtered.length === 0) {
						ctx.ui.notify(`No artifacts matching "${searchTerm}".`, "info");
						searchTerm = "";
						page = 0;
						continue;
					}

					const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
					if (page >= totalPages) page = totalPages - 1;
					const start = page * PAGE_SIZE;
					const slice = filtered.slice(start, start + PAGE_SIZE);

					const options: string[] = [];
					// Search/clear at the top for quick access
					options.push(searchTerm ? `[x] Clear search ("${searchTerm}")` : "[/] Search...");
					if (page > 0) options.push("<< Previous page");
					for (const a of slice) {
						const age = timeSince(new Date(a.updated_at));
						const cpCount = (a.checkpoints ?? []).length;
						options.push(`${a.title} (${cpCount} cp, ${age} ago) -- ${a.id}`);
					}
					if (page < totalPages - 1) options.push(">> Next page");

					const label = searchTerm
						? `Inspect artifact ("${searchTerm}", ${filtered.length} matches, page ${page + 1}/${totalPages}):`
						: `Inspect artifact (${filtered.length} total, page ${page + 1}/${totalPages}):`;

					const choice = await ctx.ui.select(label, options);
					if (!choice) return;

					if (choice === "<< Previous page") { page--; continue; }
					if (choice === ">> Next page") { page++; continue; }
					if (choice.startsWith("[x] Clear search")) { searchTerm = ""; page = 0; continue; }
					if (choice === "[/] Search...") {
						const term = await ctx.ui.input("Search artifacts:", "title, id, or type");
						if (term) { searchTerm = term; page = 0; }
						continue;
					}

					const match = choice.match(/-- (.+)$/);
					if (!match) return;
					targetId = match[1];
					break picker;
				}
			}

			const artifact = readArtifactFromDisk(targetId);
			if (!artifact) {
				ctx.ui.notify(`Artifact not found: ${targetId}`, "error");
				return;
			}

			// Collect sibling artifact summaries (lightweight -- just id, title, updated_at, type)
			const allArtifacts = listArtifactsFromDisk();
			const siblings = allArtifacts
				.map((a) => ({ id: a.id, title: a.title, updated_at: a.updated_at, type: a.type }))
				.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

			// Read the HTML template
			const extDir = dirname(fileURLToPath(import.meta.url));
			const templatePath = join(extDir, "inspect.html");
			let html = readFileSync(templatePath, "utf-8");

			// Inject artifact data before the closing </script> tag
			// Escape </ sequences to prevent XSS breakout from artifact data containing </script>
			const safeJson = (obj: unknown) => JSON.stringify(obj).replace(/<\//g, "<\\/");
			const injection = `\nwindow.__ADA_ARTIFACT__ = ${safeJson(artifact)};\n` +
				`window.__ADA_SIBLINGS__ = ${safeJson(siblings)};\n`;
			html = html.replace(
				"// \u2500\u2500 Inline data injection (used by ada-inspect command) \u2500\u2500",
				"// \u2500\u2500 Inline data injection (used by ada-inspect command) \u2500\u2500\n" + injection,
			);

			// Write to artifact folder and open in browser
			const outPath = join(artifactDir(targetId), "inspect.html");
			writeFileSync(outPath, html, "utf-8");

			try {
				execSync(`open "${outPath}"`);
			} catch {
				// Fallback for Linux
				try { execSync(`xdg-open "${outPath}"`); } catch { /* ignore */ }
			}

			const cpCount = (artifact.checkpoints ?? []).length;
			const keyCount = Object.keys(artifact.data ?? {}).length;
			ctx.ui.notify(
				`Inspecting: "${artifact.title}" (${keyCount} keys, ${cpCount} checkpoints)\n` +
				`Opened: ${outPath}`,
				"info",
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
		const dir = artifactDir(artifactId);
		const dataKeys = Object.keys(state.artifact.data);
		const keysInfo = dataKeys.length > 0
			? `\nAvailable data keys: ${dataKeys.join(", ")}`
			: "";
		input.task += `\n\nActive ADA artifact: ${artifactId}\n` +
			`Artifact folder: ${dir}/\n` +
			`Use ada_get with id="${artifactId}" to connect, then ada_update to write findings.` +
			keysInfo +
			`\n\nCHECKPOINT DISCIPLINE (mandatory):\n` +
			`Checkpoint after EVERY meaningful step. Never batch.\n` +
			`For code changes: every edit or write gets an immediate checkpoint, even before tests. Each test run gets its own checkpoint too.\n` +
			`For reads: checkpoint any important data immediately. If you loaded information with 2+ read/search/query tools, checkpoint the batch before continuing.\n` +
			`ada_update does not replace ada_checkpoint. Use both when you stored structured data and also reached a progress point.\n` +
			`Each checkpoint says what you found or changed, not the overall status. Granular, not summary.`;
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
