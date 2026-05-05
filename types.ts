export type ArtifactType = "investigation" | "fix" | "review" | "planning" | "build" | "general";

export interface Checkpoint {
	timestamp: string;
	note: string;
}

export interface InputEntry {
	timestamp: string;
	content: string;
}

export interface Artifact {
	id: string;
	title: string;
	description?: string;
	type: ArtifactType;
	created_at: string;
	updated_at: string;
	size_bytes: number;
	first_input_tokens: number | null;
	cursor: {
		last_processed_entry_id: string | null;
	};
	data: Record<string, unknown>;
	inputs: InputEntry[];
	checkpoints: Checkpoint[];
	status?: string;
	session_id?: string | null;
	summary?: string;
}

export interface ADASettings {
	constraint_tokens: number;
	restart_mode: "auto" | "ask";
	input_warn_pct: number;
	command: string;
	command_enabled: boolean;
}

export interface ADAState {
	artifact: Artifact | null;
	inputOverCap: boolean;
}

export const ADA_ROOT = `${process.env.HOME}/.pi/agent/ada`;
export const ARTIFACTS_DIR = `${ADA_ROOT}/artifacts`;
