import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readArtifactFromDisk } from "./helpers.js";
import type { ADAState, Artifact } from "./types.js";

export function registerTools(
	pi: ExtensionAPI,
	state: ADAState,
): void {

	pi.registerTool({
		name: "ada_get",
		label: "Get Artifact Data",
		description:
			"Read specific keys from the active artifact's data. Returns only the requested data, " +
			"not the full artifact. Use this to load what you need without pulling everything into context.\n\n" +
			"Pass no keys to get the artifact header (title, type, data keys list, checkpoints) " +
			"without the data itself -- useful to orient before diving in.",
		promptSnippet: "Read specific keys from the active artifact",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description: "Artifact ID to connect to. Use when you were given an artifact ID " +
						"by the lead agent and need to load it. Omit if an artifact is already active.",
				}),
			),
			keys: Type.Optional(
				Type.Array(Type.String(), {
					description: "Data keys to read. Omit to get artifact header + available keys list.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let justConnected = false;
			if (params.id && !state.artifact) {
				const loaded = readArtifactFromDisk(params.id as string);
				if (!loaded) {
					return {
						content: [{ type: "text" as const, text: `Artifact not found: ${params.id}` }],
						details: {},
					};
				}
				state.artifact = loaded;
				justConnected = true;
			}

			if (!state.artifact) {
				return {
					content: [{ type: "text" as const, text: "No active artifact. Use /ada-resume to load one, or pass an artifact id to connect." }],
					details: {},
				};
			}

			const fresh = readArtifactFromDisk(state.artifact.id);
			if (!fresh) {
				const id = state.artifact.id;
				state.artifact = null;
				return {
					content: [{ type: "text" as const, text: `Artifact "${id}" no longer exists on disk.` }],
					details: {},
				};
			}
			if (fresh.id === state.artifact.id) {
				state.artifact.data = fresh.data;
				state.artifact.checkpoints = fresh.checkpoints;
				state.artifact.size_bytes = fresh.size_bytes;
				state.artifact.cursor = fresh.cursor;
			}
			const a = state.artifact;
			const requestedKeys = params.keys as string[] | undefined;

			if (!requestedKeys || requestedKeys.length === 0 || justConnected) {
				const header: Record<string, unknown> = {
					id: a.id,
					title: a.title,
					type: a.type,
					description: a.description,
					data_keys: Object.keys(a.data),
					checkpoints: a.checkpoints,
					created_at: a.created_at,
					updated_at: a.updated_at,
				};

				if (justConnected && requestedKeys && requestedKeys.length > 0) {
					const requested: Record<string, unknown> = {};
					for (const key of requestedKeys) {
						if (key in a.data) requested[key] = a.data[key];
					}
					if (Object.keys(requested).length > 0) {
						header.requested_data = requested;
					}
				}

				return {
					content: [{ type: "text", text: JSON.stringify(header, null, 2) }],
					details: { header: true, keys: Object.keys(a.data), connected: justConnected },
				};
			}

			const result: Record<string, unknown> = {};
			const missing: string[] = [];
			for (const key of requestedKeys) {
				if (key in a.data) {
					result[key] = a.data[key];
				} else {
					missing.push(key);
				}
			}

			let text = JSON.stringify(result, null, 2);
			if (missing.length > 0) {
				text += `\n\nKeys not found: ${missing.join(", ")}`;
			}

			return {
				content: [{ type: "text", text }],
				details: { returned: Object.keys(result), missing },
			};
		},

		renderCall(args, theme) {
			const a = args as Record<string, unknown>;
			const keys = a.keys as string[] | undefined;
			let text = theme.fg("toolTitle", theme.bold("ada_get"));
			if (keys?.length) {
				text += " " + theme.fg("muted", keys.join(", "));
			} else {
				text += " " + theme.fg("dim", "(header)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Reading..."), 0, 0);
			const details = result.details as { header?: boolean; keys?: string[]; returned?: string[]; missing?: string[] } | undefined;
			if (details?.header) {
				return new Text(
					theme.fg("accent", "header") +
					theme.fg("dim", ` -- ${(details.keys ?? []).length} data keys available`),
					0, 0,
				);
			}
			if (details?.returned) {
				let text = theme.fg("success", details.returned.join(", "));
				if (details.missing?.length) {
					text += theme.fg("warning", ` (missing: ${details.missing.join(", ")})`);
				}
				return new Text(text, 0, 0);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "ada_read",
		label: "Read Artifact",
		description:
			"Read the full artifact: header, all data, and all checkpoints. " +
			"Use when resuming work from a previous session or when you need the complete picture. " +
			"For mid-work targeted reads, prefer ada_get to avoid loading everything into context.",
		promptSnippet: "Read the full artifact (use ada_get for targeted reads)",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!state.artifact) {
				return {
					content: [{ type: "text" as const, text: "No active artifact. Use /ada-resume to load one, or use ada_get with an artifact id to connect." }],
					details: {},
				};
			}

			const fresh = readArtifactFromDisk(state.artifact.id);
			if (!fresh) {
				const id = state.artifact.id;
				state.artifact = null;
				return {
					content: [{ type: "text" as const, text: `Artifact "${id}" no longer exists on disk.` }],
					details: {},
				};
			}
			if (fresh.id === state.artifact.id) {
				state.artifact.data = fresh.data;
				state.artifact.checkpoints = fresh.checkpoints;
				state.artifact.size_bytes = fresh.size_bytes;
				state.artifact.cursor = fresh.cursor;
			}

			return {
				content: [{ type: "text", text: JSON.stringify(state.artifact, null, 2) }],
				details: { artifact: state.artifact },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ada_read")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Reading..."), 0, 0);
			const details = result.details as { artifact?: Artifact } | undefined;
			if (!details?.artifact) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const a = details.artifact;
			return new Text(
				theme.fg("accent", a.title) +
				theme.fg("dim", ` -- ${Object.keys(a.data).length} keys, ${a.checkpoints.length} checkpoints`),
				0, 0,
			);
		},
	});
}
