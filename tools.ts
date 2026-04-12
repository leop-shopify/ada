/**
 * ADA Tools — ada_create, ada_update, ada_get, ada_checkpoint, ada_read
 *
 * ada_update writes key-value pairs into the artifact's data object.
 * The agent structures data however the work demands — no forced schema.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	writeArtifactToDisk, readArtifactFromDisk, persistState, slugify, artifactDir,
	acquireLock, releaseLock, findSimilarArtifacts, listArtifactsFromDisk,
} from "./helpers.js";
import type { ADAState, Artifact, ArtifactType, Checkpoint } from "./types.js";

export function registerTools(
	pi: ExtensionAPI,
	state: ADAState,
	isSpawnedAgent: boolean,
): void {

	// ─── ada_create ───────────────────────────────────────────────
	// Spawned agents don't even SEE this tool. The tool is simply not
	// registered, so it cannot appear in their tool list or be called.
	// Defense in depth: even if env detection has a gap, the tool
	// won't exist in their runtime. The execute() guard remains as
	// a belt-and-suspenders safety net.

	if (!isSpawnedAgent) pi.registerTool({
		name: "ada_create",
		label: "Create Artifact",
		description:
			"Create a new ADA artifact to track iterative work. Use when starting any multi-step task: " +
			"performance investigations, bug fixes, code reviews, planning sessions, or any work that " +
			"involves iteration. Only one artifact can be active at a time.",
		promptSnippet: "Create an ADA artifact to track multi-step or iterative work",
		promptGuidelines: [
			"Create an artifact when work involves iteration, tracking, or multiple steps — performance investigations, bug fixes, code reviews, planning, anything non-trivial.",
			"Always create an artifact before starting multi-step work. Update it as you go.",
			"One artifact at a time. Creating a new one detaches the previous.",
			"NEVER create a duplicate artifact. If one already exists for the same work, use /ada-resume to switch to it. The tool will block you if a similar artifact exists.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short descriptive title for the work being tracked" }),
			type: Type.Optional(
				StringEnum(["investigation", "fix", "review", "planning", "build", "general"] as const, {
					description: "Category of work. Default: general",
				}),
			),
			description: Type.Optional(
				Type.String({ description: "Longer description of the task, goals, or context" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Hard guardrail: spawned agents must NEVER create artifacts.
			if (isSpawnedAgent) {
				return {
					content: [{
						type: "text" as const,
						text: "BLOCKED: Spawned agents cannot create artifacts. " +
							"Use ada_get with the artifact ID from your task prompt to connect to the lead's artifact. " +
							"Then use ada_update and ada_checkpoint to write your findings.",
					}],
					details: {},
				};
			}

			// Block if an artifact is already active. Use /ada-resume to switch.
			if (state.artifact) {
				return {
					content: [{
						type: "text" as const,
						text: `An artifact is already active: "${state.artifact.title}" (${state.artifact.id}). ` +
							`Use /ada-resume to switch artifacts. Do NOT try to close and recreate.`,
					}],
					details: {},
				};
			}

			const slug = slugify(params.title);
			const { existsSync } = await import("node:fs");

			// ── Guard 1: Exact slug collision ──
			// NEVER create a timestamp-suffixed duplicate. If the slug exists, the
			// artifact already exists. The agent must resume it instead.
			if (existsSync(artifactDir(slug))) {
				const existing = readArtifactFromDisk(slug);
				const existingTitle = existing?.title ?? slug;
				return {
					content: [{
						type: "text" as const,
						text: `BLOCKED: An artifact with this slug already exists: "${existingTitle}" (${slug}).\n` +
							`Use /ada-resume ${slug} to switch to it. Do NOT create a duplicate.`,
					}],
					details: { blocked_reason: "exact_slug_collision", existing_id: slug },
				};
			}

			// ── Guard 2: Similar title detection ──
			// Catch near-duplicates like "PR Review Triage" vs "PR Review Triage - Apr 8"
			const similar = findSimilarArtifacts(params.title);
			if (similar.length > 0) {
				const matches = similar
					.slice(0, 3)
					.map((s) => `  - "${s.artifact.title}" (${s.artifact.id}) [${Math.round(s.similarity * 100)}% similar]`)
					.join("\n");
				return {
					content: [{
						type: "text" as const,
						text: `BLOCKED: Similar artifact(s) already exist:\n${matches}\n\n` +
							`Use /ada-resume <id> to switch to an existing artifact instead of creating a duplicate. ` +
							`Only create a new artifact if the work is genuinely unrelated to all of the above.`,
					}],
					details: { blocked_reason: "similar_title", similar: similar.map((s) => s.artifact.id) },
				};
			}

			const now = new Date();
			const artifact: Artifact = {
				id: slug,
				title: params.title,
				description: params.description,
				type: (params.type as ArtifactType) ?? "general",
				created_at: now.toISOString(),
				updated_at: now.toISOString(),
				data: {},
				checkpoints: [],
			};

			state.artifact = artifact;
			writeArtifactToDisk(artifact);
			persistState(pi, state);

			const artDir = artifactDir(artifact.id);
			return {
				content: [{
					type: "text",
					text: `Artifact created: "${artifact.title}" (${artifact.id})\nType: ${artifact.type}\nPath: ${artDir}/artifact.json`,
				}],
				details: { artifact },
			};
		},

		renderCall(args, theme) {
			const a = args as Record<string, unknown>;
			return new Text(
				theme.fg("toolTitle", theme.bold("ada_create ")) +
				theme.fg("accent", `[${a.type ?? "general"}] `) +
				theme.fg("muted", `"${a.title}"`),
				0, 0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Creating..."), 0, 0);
			const details = result.details as { artifact?: Artifact } | undefined;
			if (!details?.artifact) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const a = details.artifact;
			return new Text(
				theme.fg("success", a.title) +
				theme.fg("dim", ` (${a.type}) ${a.id}`),
				0, 0,
			);
		},
	});

	// ─── ada_update ───────────────────────────────────────────────

	pi.registerTool({
		name: "ada_update",
		label: "Update Artifact",
		description:
			"Update the active artifact's data. Writes key-value pairs into the artifact's data object. " +
			"The agent structures data however the work demands — there is no forced schema. " +
			"Use this to store measurements, track state, record findings, maintain structured data, " +
			"or anything the work needs. The artifact is a living document, not a log.\n\n" +
			"Examples:\n" +
			"- Performance: { \"baseline_ms\": 450, \"current_ms\": 120, \"optimization\": \"index on user_id\" }\n" +
			"- Review: { \"alice\": { \"status\": \"done\", \"questions_done\": 5 } }\n" +
			"- Bug fix: { \"root_cause\": \"null check missing in handler\", \"files\": [\"order.rb\", \"processor.rb\"] }",
		promptSnippet: "Update the active artifact's working data (free-form key-value pairs)",
		parameters: Type.Object({
			data: Type.Record(Type.String(), Type.Unknown(), {
				description: "Key-value pairs to merge into the artifact's data object. " +
					"Existing keys are overwritten, new keys are added. " +
					"Use nested objects for structured data.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!state.artifact) {
				return {
					content: [{ type: "text" as const, text: "No active artifact. Create one with ada_create, or use ada_get with an artifact id to connect." }],
					details: {},
				};
			}

			const updates = params.data as Record<string, unknown>;
			const keys = Object.keys(updates);
			if (keys.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No data provided. Pass key-value pairs to update." }],
					details: {},
				};
			}

			// Lock, re-read from disk (another agent may have written), merge, write back
			await acquireLock(state.artifact.id);
			try {
				const fresh = readArtifactFromDisk(state.artifact.id);
				if (fresh && fresh.id === state.artifact.id) {
					state.artifact.data = fresh.data;
					state.artifact.checkpoints = fresh.checkpoints;
				}
				for (const [key, value] of Object.entries(updates)) {
					state.artifact.data[key] = value;
				}
				state.artifact.updated_at = new Date().toISOString();
				writeArtifactToDisk(state.artifact);
				persistState(pi, state);
			} finally {
				releaseLock(state.artifact.id);
			}

			return {
				content: [{
					type: "text",
					text: `Artifact updated: ${keys.join(", ")} (${Object.keys(state.artifact.data).length} total keys)`,
				}],
				details: { updatedKeys: keys, totalKeys: Object.keys(state.artifact.data).length },
			};
		},

		renderCall(args, theme) {
			const a = args as Record<string, unknown>;
			const data = a.data as Record<string, unknown> | undefined;
			const keys = data ? Object.keys(data) : [];
			return new Text(
				theme.fg("toolTitle", theme.bold("ada_update ")) +
				theme.fg("muted", keys.length > 0 ? keys.join(", ") : "(empty)"),
				0, 0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "Updating..."), 0, 0);
			const details = result.details as { updatedKeys?: string[]; totalKeys?: number } | undefined;
			if (!details?.updatedKeys) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", details.updatedKeys.join(", ")) +
				theme.fg("dim", ` (${details.totalKeys} total keys)`),
				0, 0,
			);
		},
	});

	// ─── ada_checkpoint ─────────────────────────────────────────

	pi.registerTool({
		name: "ada_checkpoint",
		label: "Artifact Checkpoint",
		description:
			"Mark a checkpoint in the active artifact. Checkpoints are progress breadcrumbs " +
			"that mark milestones -- not a journal. Use when reaching a meaningful point: " +
			"a phase completed, a key measurement taken, a decision made that changes direction.",
		promptSnippet: "Mark a progress checkpoint in the active artifact",
		parameters: Type.Object({
			note: Type.String({ description: "What milestone was reached or what changed" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!state.artifact) {
				return {
					content: [{ type: "text" as const, text: "No active artifact. Use ada_get with an artifact id to connect, or ada_create to start a new one." }],
					details: {},
				};
			}

			// Spawned agents prepend their name so the lead knows who wrote each checkpoint
			let note = params.note as string;
			if (isSpawnedAgent) {
				const agentName = process.env.PI_TEAM_AGENT_NAME;
				if (agentName) {
					note = `[@${agentName}] ${note}`;
				}
			}

			const checkpoint: Checkpoint = {
				timestamp: new Date().toISOString(),
				note,
			};

			await acquireLock(state.artifact.id);
			try {
				const fresh = readArtifactFromDisk(state.artifact.id);
				if (fresh && fresh.id === state.artifact.id) {
					state.artifact.data = fresh.data;
					state.artifact.checkpoints = fresh.checkpoints;
				}
				state.artifact.checkpoints.push(checkpoint);
				state.artifact.updated_at = new Date().toISOString();
				writeArtifactToDisk(state.artifact);
				persistState(pi, state);
			} finally {
				releaseLock(state.artifact.id);
			}

			return {
				content: [{
					type: "text",
					text: `Checkpoint #${state.artifact.checkpoints.length}: ${params.note}`,
				}],
				details: { checkpoint, total: state.artifact.checkpoints.length },
			};
		},

		renderCall(args, theme) {
			const a = args as Record<string, unknown>;
			return new Text(
				theme.fg("toolTitle", theme.bold("ada_checkpoint ")) +
				theme.fg("muted", `"${(a.note as string || "").slice(0, 60)}"`),
				0, 0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "..."), 0, 0);
			const details = result.details as { checkpoint?: Checkpoint; total?: number } | undefined;
			if (!details?.checkpoint) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", `#${details.total} `) +
				theme.fg("dim", details.checkpoint.note.slice(0, 80)),
				0, 0,
			);
		},
	});

	// ─── ada_get ──────────────────────────────────────────────────

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
			// Connect to artifact by ID if provided (spawned agents use this)
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
					content: [{ type: "text" as const, text: "No active artifact. Create one with ada_create, or pass an artifact id to connect." }],
					details: {},
				};
			}

			// Re-read from disk to get latest (another agent may have updated)
			const fresh = readArtifactFromDisk(state.artifact.id);
			if (!fresh) {
				// Artifact was deleted from disk
				const id = state.artifact.id;
				state.artifact = null;
				return {
					content: [{ type: "text" as const, text: `Artifact "${id}" no longer exists on disk. It may have been cleaned up or deleted.` }],
					details: {},
				};
			}
			if (fresh.id === state.artifact.id) {
				state.artifact.data = fresh.data;
				state.artifact.checkpoints = fresh.checkpoints;
			}
			const a = state.artifact;
			const requestedKeys = params.keys as string[] | undefined;

			// No keys OR just connected: return header with available keys list.
			// When an agent connects via id, always show the header so they know
			// what keys exist -- eliminates the guess-miss-header-retry pattern.
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

				// If caller also requested specific keys on connect, include them
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

			// Specific keys: return only those
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

	// ─── ada_read ─────────────────────────────────────────────────

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
					content: [{ type: "text" as const, text: "No active artifact. Use ada_get with an artifact id to connect, or ada_create to start a new one." }],
					details: {},
				};
			}

			// Re-read from disk to get latest
			const fresh = readArtifactFromDisk(state.artifact.id);
			if (!fresh) {
				const id = state.artifact.id;
				state.artifact = null;
				return {
					content: [{ type: "text" as const, text: `Artifact "${id}" no longer exists on disk. It may have been cleaned up or deleted.` }],
					details: {},
				};
			}
			if (fresh.id === state.artifact.id) {
				state.artifact.data = fresh.data;
				state.artifact.checkpoints = fresh.checkpoints;
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
