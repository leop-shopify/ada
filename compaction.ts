import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ADASettings, ADAState } from "./types.js";
import { formatSize } from "./helpers.js";

let compactingNow = false;

export function buildDeterministicSummary(state: ADAState): string {
	const a = state.artifact;
	if (!a) return "";

	const lines: string[] = [];
	lines.push(`## Active Artifact: "${a.title}" (${a.type})`);
	lines.push("");

	const dataKeys = Object.keys(a.data);
	if (dataKeys.length > 0) {
		lines.push(`### Data Keys (${dataKeys.length})`);
		for (const key of dataKeys) {
			const val = a.data[key];
			const preview = typeof val === "string"
				? val.slice(0, 200)
				: JSON.stringify(val)?.slice(0, 200) ?? "(null)";
			lines.push(`- **${key}**: ${preview}`);
		}
		lines.push("");
	}

	const cpCount = a.checkpoints.length;
	if (cpCount > 0) {
		const recent = a.checkpoints.slice(-10);
		lines.push(`### Recent Checkpoints (last ${recent.length} of ${cpCount})`);
		for (const cp of recent) {
			lines.push(`- [${cp.timestamp}] ${cp.note}`);
		}
		lines.push("");
	}

	lines.push(`Size: ${formatSize(a.size_bytes)} | Created: ${a.created_at} | Updated: ${a.updated_at}`);

	return lines.join("\n");
}

export function registerSoftRestart(
	pi: ExtensionAPI,
	state: ADAState,
	getSettings: () => ADASettings,
): void {

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.artifact) return;
		if (compactingNow) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		const settings = getSettings();
		if (usage.tokens <= settings.constraint_tokens) return;

		compactingNow = true;

		if (settings.restart_mode === "auto") {
			triggerCompact(ctx);
		} else {
			const confirmed = await ctx.ui.confirm(
				"ADA Soft Restart",
				`Context is at ${usage.tokens.toLocaleString()} tokens (cap: ${settings.constraint_tokens.toLocaleString()}). Compact now?`,
			);
			if (confirmed) {
				triggerCompact(ctx);
			} else {
				compactingNow = false;
			}
		}
	});

	pi.on("session_before_compact", async (event) => {
		if (!state.artifact) return;

		const { preparation } = event;
		const summary = buildDeterministicSummary(state);

		compactingNow = false;

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { source: "ada-v2", artifact_id: state.artifact.id },
			},
		};
	});
}

function triggerCompact(ctx: ExtensionContext): void {
	ctx.compact({
		onComplete: () => {
			compactingNow = false;
		},
		onError: () => {
			compactingNow = false;
		},
	});
}

export function registerCompactCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ada-compact", {
		description: "Force a soft-restart (compaction) now",
		handler: async (_args, ctx) => {
			compactingNow = true;
			ctx.compact({
				onComplete: () => {
					compactingNow = false;
					if (ctx.hasUI) ctx.ui.notify("Compaction complete.", "info");
				},
				onError: (err) => {
					compactingNow = false;
					if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${err.message}`, "warning");
				},
			});
		},
	});
}
