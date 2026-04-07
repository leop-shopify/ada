/**
 * ADA — Artifact Driven Agent
 *
 * Type definitions for the structured artifact system.
 * Artifacts are living JSON documents that the agent reads, updates, and acts on.
 * The data section is free-form — the agent structures it however the work demands.
 *
 * Storage layout:
 *   ~/.pi/agent/artifacts/{slug}/artifact.json
 */

/** Artifact lifecycle status. */
export type ArtifactStatus = "active" | "completed" | "paused";

/** High-level artifact category for prompt context. */
export type ArtifactType = "investigation" | "fix" | "review" | "planning" | "build" | "general";

/** A checkpoint marking a meaningful moment in the artifact's evolution. */
export interface Checkpoint {
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** What milestone was reached or what changed. */
	note: string;
}

/** The full artifact document, serialized to JSON on disk. */
export interface Artifact {
	/** Unique identifier: slug derived from title. */
	id: string;
	/** Human-readable title describing the work. */
	title: string;
	/** Optional longer description of the task, goals, or context. */
	description?: string;
	/** Category of work being tracked. */
	type: ArtifactType;
	/** Current lifecycle status. */
	status: ArtifactStatus;
	/** Pi session file that owns this artifact. Prevents cross-session leaking. */
	session_id: string | null;
	/** ISO 8601 creation timestamp. */
	created_at: string;
	/** ISO 8601 last-update timestamp. */
	updated_at: string;
	/**
	 * Free-form working data. The agent owns this entirely.
	 * A living document enriched every iteration. Structure depends on the work:
	 * measurements for perf investigations, people/questions/responses for reviews,
	 * files/hypotheses for bug fixes. Queryable, mutable, the real substance.
	 */
	data: Record<string, unknown>;
	/** Progress breadcrumbs. Marks milestones, not a journal. */
	checkpoints: Checkpoint[];
	/** Final summary written when the artifact is closed. */
	summary?: string;
}

/** Mutable runtime state shared across all ADA modules. */
export interface ADAState {
	/** The currently active artifact, or null. */
	artifact: Artifact | null;
	/** Whether any artifact tool was called this turn (for nudge tracking). */
	artifactUpdatedThisTurn: boolean;
	/** Count of substantive tool calls this turn (for nudge heuristic). */
	toolCallsThisTurn: number;
	/** Current Pi session file path, set on session_start. */
	sessionId: string | null;
}

/** Default artifacts directory. */
export const ARTIFACTS_DIR = `${process.env.HOME}/.pi/agent/artifacts`;
