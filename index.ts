import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
	listArtifactsFromDisk,
	readArtifactFromDisk,
	persistState,
	artifactDir,
	jewelryForComplexity,
	formatSize,
	timeSince,
	slugify,
} from "./helpers.js";
import { registerTools } from "./tools.js";
import { loadSettings, registerSettingsCommand } from "./settings.js";
import {
	spawnTrackInput,
	spawnSetMeta,
	spawnCleanupOld,
	spawnResponseParser,
	lastAssistantText,
} from "./subprocess.js";
import { registerSoftRestart, registerCompactCommand } from "./compaction.js";
import type { ADAState, Artifact } from "./types.js";

const ADA_WIDGET_KEY = "ada-artifact-banner";

export default function adaExtension(pi: ExtensionAPI): void {
	if (process.env.ADA_SUBPROCESS === "1") return;

	const isSpawnedAgent = process.env.PI_AGENT_ROLE === "subagent" ||
		process.env.PI_TEAM_NAME !== undefined;

	const state: ADAState = {
		artifact: null,
		inputOverCap: false,
	};

	let currentCtx: ExtensionContext | null = null;
	let firstTurnDone = false;
	let watcher: FSWatcher | null = null;
	let watchedId: string | null = null;
	let refreshTimer: NodeJS.Timeout | null = null;
	let realUserTurnInFlight = false;

	function getSettings() {
		return loadSettings();
	}

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
		const size = formatSize(a.size_bytes);

		c.ui.setWidget(ADA_WIDGET_KEY, (_tui, theme) => {
			return {
				render: (width: number) => {
					const sep = theme.fg("dim", " | ");
					let content =
						`  ADA ${jewelry}` + sep +
						theme.fg("accent", theme.bold(a.title)) + sep +
						theme.fg("muted", size) + sep +
						theme.fg("muted", `${cpCount} checkpoints`);

					if (state.inputOverCap) {
						content += sep + theme.fg("warning", "[INPUT >10% CAP]");
					}

					const bar = theme.fg("dim", "-".repeat(width));
					return [bar, truncateToWidth(content, width), bar];
				},
				invalidate: () => {},
			};
		});
	}

	function refreshFromDisk(): void {
		if (!state.artifact) return;
		const fresh = readArtifactFromDisk(state.artifact.id);
		if (fresh) {
			state.artifact = fresh;
			updateBanner();
		}
	}

	function attachWatcher(): void {
		if (!state.artifact) return;
		if (watchedId === state.artifact.id) return;
		detachWatcher();
		const filePath = join(artifactDir(state.artifact.id), "artifact.json");
		try {
			watcher = watch(filePath, { persistent: false }, () => {
				if (refreshTimer) return;
				refreshTimer = setTimeout(() => {
					refreshTimer = null;
					refreshFromDisk();
				}, 100);
			});
			watchedId = state.artifact.id;
		} catch {  }
	}

	function detachWatcher(): void {
		if (watcher) {
			try { watcher.close(); } catch {  }
			watcher = null;
		}
		watchedId = null;
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function restoreState(ctx: ExtensionContext): void {
		state.artifact = null;
		state.inputOverCap = false;
		currentCtx = ctx;
		firstTurnDone = false;
		detachWatcher();

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

		spawnCleanupOld(7);
		updateBanner(ctx);
		attachWatcher();
	}

	pi.on("session_start", async (_event, ctx) => {
		realUserTurnInFlight = false;
		restoreState(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		realUserTurnInFlight = false;
		restoreState(ctx);
	});

	pi.on("input", async (event) => {
		realUserTurnInFlight = event.source !== "extension";
		return { action: "continue" };
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.on("before_agent_start", async (event) => {
		const userInput = event.prompt ?? "";
		if (!realUserTurnInFlight) {
			updateBanner();
			if (!state.artifact || isSpawnedAgent) return;
			const a = state.artifact;
			const dataKeys = Object.keys(a.data);
			const cpCount = a.checkpoints.length;
			const lastCp = cpCount > 0 ? a.checkpoints[cpCount - 1].note : null;
			const keysLine = dataKeys.length > 0 ? `\nData keys (${dataKeys.length}): ${dataKeys.join(", ")}` : "";
			const cpLine = lastCp ? `\nLast checkpoint (#${cpCount}): ${lastCp}` : "";
			const contextText = `[BACKGROUND STATE -- not the conversation topic]\nActive artifact: "${a.title}" (${a.type}) -- ${a.id}${keysLine}${cpLine}\nUse ada_get with specific key names above to load data when needed.`;
			const systemText = `${contextText}\nIf the user asks about current work, previous work, implementation status, decisions, files changed, or what happened, call ada_get before answering. Use ada_get with no keys first to inspect the artifact header, then request specific keys if needed.`;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${systemText}`,
			};
		}

		if (!state.artifact && !isSpawnedAgent) {
			const seed = userInput
				.slice(0, 60)
				.replace(/\n/g, " ")
				.replace(/[^a-zA-Z0-9 _\-]/g, "")
				.trim() || "artifact";
			const slug = slugify(seed) || `artifact-${Date.now().toString(36)}`;
			const title = slug;
			const id = slug;
			const now = new Date();
			const tzOffset = -now.getTimezoneOffset();
			const tzH = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
			const tzM = String(Math.abs(tzOffset) % 60).padStart(2, "0");
			const tzSign = tzOffset >= 0 ? "+" : "-";
			const isoWithTz = now.toISOString().replace("Z", `${tzSign}${tzH}:${tzM}`);

			state.artifact = {
				id,
				title,
				type: "general",
				created_at: isoWithTz,
				updated_at: isoWithTz,
				size_bytes: 0,
				first_input_tokens: null,
				cursor: { last_processed_entry_id: null },
				data: {},
				inputs: [],
				checkpoints: [],
			};
			persistState(pi, state);
			attachWatcher();
		}

		if (state.artifact && userInput && !isSpawnedAgent) {
			spawnTrackInput(state.artifact.id, state.artifact.title, userInput);
		}

		refreshFromDisk();
		attachWatcher();

		const settings = getSettings();
		const promptLen = userInput.length;
		const approxTokens = Math.ceil(promptLen / 4);
		state.inputOverCap = approxTokens > settings.constraint_tokens * settings.input_warn_pct;

		updateBanner();

		if (!state.artifact) return;
		if (isSpawnedAgent) return;

		const a = state.artifact;
		const dataKeys = Object.keys(a.data);
		const cpCount = a.checkpoints.length;
		const lastCp = cpCount > 0 ? a.checkpoints[cpCount - 1].note : null;

		let keysLine = "";
		if (dataKeys.length > 0) {
			keysLine = `\nData keys (${dataKeys.length}): ${dataKeys.join(", ")}`;
		}
		let cpLine = "";
		if (lastCp) {
			cpLine = `\nLast checkpoint (#${cpCount}): ${lastCp}`;
		}

		const contextText = `[BACKGROUND STATE -- not the conversation topic]\nActive artifact: "${a.title}" (${a.type}) -- ${a.id}${keysLine}${cpLine}\nUse ada_get with specific key names above to load data when needed.`;
		const systemText = `${contextText}\nIf the user asks about current work, previous work, implementation status, decisions, files changed, or what happened, call ada_get before answering. Use ada_get with no keys first to inspect the artifact header, then request specific keys if needed.`;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${systemText}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.artifact) return;
		const shouldTrackTurn = realUserTurnInFlight && !isSpawnedAgent;
		realUserTurnInFlight = false;

		if (!shouldTrackTurn) return;

		if (!firstTurnDone) {
			firstTurnDone = true;
			const usage = ctx.getContextUsage();
			if (usage && usage.tokens !== null && state.artifact.first_input_tokens === null) {
				spawnSetMeta(state.artifact.id, { first_input_tokens: usage.tokens });
			}
		}

		const settings = getSettings();
		if (settings.command_enabled && settings.command.trim() && event.messages?.length) {
			const assistant = lastAssistantText(event.messages);
			if (assistant) {
				spawnResponseParser(state.artifact, assistant, settings.command);
			}
		}
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				if (msg.customType === "ada-nudge") return false;
				if (msg.customType === "ada-context") return false;
				return true;
			}),
		};
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "team_spawn") return;
		if (!state.artifact) return;
		if (isSpawnedAgent) return;

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
			`Use ada_get with id="${artifactId}" to connect, then ada_get with specific keys to load what you need. ` +
			`Artifacts are read-only from agents. ada_create, ada_update, and ada_checkpoint do not exist. ` +
			`Just do the work and report back; the artifact reflects what happened.` +
			keysInfo;
	});

	registerAdaResumeCommand(pi, state, updateBanner, attachWatcher);
	registerAdaInspectCommand(pi, state);
	registerCompactCommand(pi);
	registerSettingsCommand(pi);
	registerSoftRestart(pi, state, getSettings);
	registerTools(pi, state);
}

function registerAdaResumeCommand(
	pi: ExtensionAPI,
	state: ADAState,
	updateBanner: (ctx?: ExtensionContext) => void,
	attachWatcher: () => void,
): void {
	pi.registerCommand("ada-resume", {
		description: "Resume an ADA artifact by ID, interactive picker, or search",
		handler: async (args, ctx) => {
			let id = (args ?? "").trim();

			if (id && id !== "/" && id.toLowerCase() !== "search") {
				const direct = readArtifactFromDisk(id);
				if (direct) {
					await completeResume(direct);
					return;
				}
			}

			const all = listArtifactsFromDisk();
			const currentId = state.artifact?.id;
			const pool = all.filter((a) => a.id !== currentId);
			if (pool.length === 0) {
				ctx.ui.notify("No other artifacts to resume.", "info");
				return;
			}

			const term = await ctx.ui.input("Search artifacts (empty for all):", "title, id, or type");
			if (term === undefined) return;
			const searchTerm = term.trim();

			const filtered = searchTerm
				? pool.filter((a) => `${a.title} ${a.id} ${a.type}`.toLowerCase().includes(searchTerm.toLowerCase()))
				: pool;

			if (filtered.length === 0) {
				ctx.ui.notify(`No artifacts matching "${searchTerm}".`, "info");
				return;
			}

			const PAGE_SIZE = 20;
			let page = 0;

			while (true) {
				const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
				if (page >= totalPages) page = totalPages - 1;
				if (page < 0) page = 0;
				const start = page * PAGE_SIZE;
				const slice = filtered.slice(start, start + PAGE_SIZE);

				const options: string[] = [];
				if (page > 0) options.push("<< Previous page");
				for (const a of slice) {
					const age = timeSince(new Date(a.updated_at));
					options.push(`${a.title} (${Object.keys(a.data ?? {}).length} keys, ${age}) -- ${a.id}`);
				}
				if (page < totalPages - 1) options.push(">> Next page");

				const label = searchTerm
					? `Resume ("${searchTerm}", ${filtered.length} matches, page ${page + 1}/${totalPages}):`
					: `Resume (${filtered.length} total, page ${page + 1}/${totalPages}):`;

				const choice = await ctx.ui.select(label, options);
				if (!choice) return;
				if (choice === "<< Previous page") { page--; continue; }
				if (choice === ">> Next page") { page++; continue; }

				const match = choice.match(/-- (.+)$/);
				if (!match) return;
				id = match[1];
				break;
			}

			const artifact = readArtifactFromDisk(id);
			if (!artifact) {
				ctx.ui.notify(`Artifact not found: ${id}`, "error");
				return;
			}
			await completeResume(artifact);

			async function completeResume(a: Artifact): Promise<void> {
				if (state.artifact) spawnSetMeta(state.artifact.id, {});
				state.artifact = a;
				spawnSetMeta(a.id, {});
				persistState(pi, state);

				const dataKeys = Object.keys(a.data ?? {});
				const cpCount = (a.checkpoints ?? []).length;
				ctx.ui.notify(`Resumed: "${a.title}" (${dataKeys.length} keys, ${cpCount} checkpoints)`, "info");
				updateBanner(ctx);
				attachWatcher();


			}
		},
	});
}

function registerAdaInspectCommand(
	pi: ExtensionAPI,
	state: ADAState,
): void {
	pi.registerCommand("ada-inspect", {
		description: "Open a visual artifact inspector in the browser",
		handler: async (args, ctx) => {
			const { readFileSync, writeFileSync } = await import("node:fs");
			const { join, dirname } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const { execSync } = await import("node:child_process");

			let targetId = (args ?? "").trim();
			if (!targetId && state.artifact) targetId = state.artifact.id;

			if (!targetId) {
				const all = listArtifactsFromDisk();
				if (all.length === 0) {
					ctx.ui.notify("No artifacts to inspect.", "info");
					return;
				}

				const PAGE_SIZE = 20;
				let page = 0;
				let searchTerm = "";

				while (true) {
					const filtered = searchTerm
						? all.filter((a) => `${a.title} ${a.id} ${a.type}`.toLowerCase().includes(searchTerm.toLowerCase()))
						: all;

					if (filtered.length === 0) {
						ctx.ui.notify(`No artifacts matching "${searchTerm}".`, "info");
						searchTerm = "";
						page = 0;
						continue;
					}

					const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
					if (page >= totalPages) page = totalPages - 1;
					if (page < 0) page = 0;
					const start = page * PAGE_SIZE;
					const slice = filtered.slice(start, start + PAGE_SIZE);

					const options: string[] = [];
					options.push(searchTerm ? `[x] Clear search ("${searchTerm}")` : "[/] Search...");
					if (page > 0) options.push("<< Previous page");
					for (const a of slice) {
						const age = timeSince(new Date(a.updated_at));
						const cpCount = (a.checkpoints ?? []).length;
						options.push(`${a.title} (${cpCount} cp, ${age}) -- ${a.id}`);
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
					break;
				}
			}

			const artifact = readArtifactFromDisk(targetId);
			if (!artifact) {
				ctx.ui.notify(`Artifact not found: ${targetId}`, "error");
				return;
			}

			const allArtifacts = listArtifactsFromDisk();
			const siblings = allArtifacts
				.map((a) => ({ id: a.id, title: a.title, updated_at: a.updated_at, type: a.type }))
				.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

			const extDir = dirname(fileURLToPath(import.meta.url));
			const templatePath = join(extDir, "inspect.html");
			let html = readFileSync(templatePath, "utf-8");

			const safeJson = (obj: unknown) => JSON.stringify(obj).replace(/<\//g, "<\\/");
			const injection = `\nwindow.__ADA_ARTIFACT__ = ${safeJson(artifact)};\n` +
				`window.__ADA_SIBLINGS__ = ${safeJson(siblings)};\n`;

			const marker = "// -- Inline data injection (used by ada-inspect command) --";
			if (html.includes(marker)) {
				html = html.replace(marker, marker + "\n" + injection);
			} else {
				html = html.replace("</script>", injection + "\n</script>");
			}

			const outPath = join(artifactDir(targetId), "inspect.html");
			writeFileSync(outPath, html, "utf-8");

			try {
				execSync(`open "${outPath}"`);
			} catch {
				try { execSync(`xdg-open "${outPath}"`); } catch {  }
			}

			const cpCount = (artifact.checkpoints ?? []).length;
			const keyCount = Object.keys(artifact.data ?? {}).length;
			ctx.ui.notify(
				`Inspecting: "${artifact.title}" (${keyCount} keys, ${cpCount} checkpoints)\nOpened: ${outPath}`,
				"info",
			);
		},
	});
}
