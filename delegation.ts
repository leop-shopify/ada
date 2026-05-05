import type { Artifact } from "./types.js";

type DelegationEnv = Record<string, string | undefined>;
type MutableTaskSpec = { task?: unknown };
type MutableDelegationInput = MutableTaskSpec & {
	tasks?: unknown;
	chain?: unknown;
	tool_uses?: unknown;
};
type MutableWrappedToolUse = {
	recipient_name?: unknown;
	parameters?: unknown;
};

export function isSpawnedAgentEnv(env: DelegationEnv): boolean {
	const legacySubagent = env.PI_AGENT_ROLE === "subagent";
	const teamTeammate = env.PI_TEAM_ROLE === "teammate" && Boolean(env.PI_TEAM_NAME && env.PI_TEAM_AGENT_NAME);
	const teamSubagent = env.PI_TEAM_SPAWN_KIND === "subagent";
	return legacySubagent || teamTeammate || teamSubagent;
}

export function buildDelegatedArtifactContext(artifact: Artifact, dir: string): string {
	const dataKeys = Object.keys(artifact.data ?? {});
	const keysInfo = dataKeys.length > 0 ? `\nAvailable data keys: ${dataKeys.join(", ")}` : "";
	const folder = dir.endsWith("/") ? dir : `${dir}/`;

	return `Active ADA artifact: ${artifact.id}\n` +
		`Artifact folder: ${folder}\n` +
		`Always use this artifact for the delegated work. Do not create or resume a different ADA artifact. ` +
		`Use ada_get with id="${artifact.id}" to connect when you need artifact metadata. ` +
		`Save requested result files inside the artifact folder. ` +
		`Use ada_record when you need to persist structured facts into artifact.json with a checkpoint.` +
		keysInfo;
}

function appendContext(task: string, artifactId: string, context: string): string {
	if (task.includes(`Active ADA artifact: ${artifactId}`)) return task;
	return `${task}\n\n${context}`;
}

function appendToSpec(spec: unknown, artifactId: string, context: string): boolean {
	if (!spec || typeof spec !== "object") return false;
	const target = spec as MutableTaskSpec;
	if (typeof target.task !== "string" || target.task.length === 0) return false;
	const next = appendContext(target.task, artifactId, context);
	if (next === target.task) return false;
	target.task = next;
	return true;
}

function baseToolName(toolName: string): string {
	return toolName.split(".").pop() ?? toolName;
}

export function injectAdaContextIntoDelegation(toolName: string, input: unknown, artifact: Artifact, dir: string): boolean {
	if (!input || typeof input !== "object") return false;
	const target = input as MutableDelegationInput;
	const context = buildDelegatedArtifactContext(artifact, dir);
	const name = baseToolName(toolName);

	if (name === "team_spawn") {
		return appendToSpec(target, artifact.id, context);
	}

	if (name === "parallel" && Array.isArray(target.tool_uses)) {
		let changed = false;
		for (const toolUse of target.tool_uses) {
			if (!toolUse || typeof toolUse !== "object") continue;
			const wrapped = toolUse as MutableWrappedToolUse;
			if (typeof wrapped.recipient_name !== "string") continue;
			changed = injectAdaContextIntoDelegation(wrapped.recipient_name, wrapped.parameters, artifact, dir) || changed;
		}
		return changed;
	}

	if (name !== "subagent") return false;

	let changed = appendToSpec(target, artifact.id, context);

	if (Array.isArray(target.tasks)) {
		for (const spec of target.tasks) changed = appendToSpec(spec, artifact.id, context) || changed;
	}

	if (Array.isArray(target.chain)) {
		for (const spec of target.chain) changed = appendToSpec(spec, artifact.id, context) || changed;
	}

	return changed;
}
