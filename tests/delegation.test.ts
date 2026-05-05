import { describe, expect, it } from "vitest";
import { injectAdaContextIntoDelegation, isSpawnedAgentEnv } from "../delegation.js";
import type { Artifact } from "../types.js";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "art-1",
		title: "Artifact One",
		type: "general",
		created_at: "2026-05-05T10:00:00-04:00",
		updated_at: "2026-05-05T10:00:00-04:00",
		size_bytes: 0,
		first_input_tokens: null,
		cursor: { last_processed_entry_id: null },
		data: {},
		inputs: [],
		checkpoints: [],
		...overrides,
	};
}

describe("isSpawnedAgentEnv", () => {
	it("does not classify named leads as spawned agents", () => {
		expect(isSpawnedAgentEnv({ PI_TEAM_NAME: "team-1" })).toBe(false);
		expect(isSpawnedAgentEnv({ PI_TEAM_NAME: "team-1", PI_TEAM_ROLE: "lead", PI_TEAM_AGENT_NAME: "team_lead" })).toBe(false);
	});

	it("classifies agent-teams teammates as spawned agents", () => {
		expect(isSpawnedAgentEnv({ PI_TEAM_NAME: "team-1", PI_TEAM_ROLE: "teammate", PI_TEAM_AGENT_NAME: "worker" })).toBe(true);
	});

	it("classifies agent-teams subagents as spawned agents", () => {
		expect(isSpawnedAgentEnv({ PI_TEAM_NAME: "team-1", PI_TEAM_ROLE: "teammate", PI_TEAM_AGENT_NAME: "worker", PI_TEAM_SPAWN_KIND: "subagent" })).toBe(true);
	});

	it("keeps legacy subagent support", () => {
		expect(isSpawnedAgentEnv({ PI_AGENT_ROLE: "subagent" })).toBe(true);
	});
});

describe("injectAdaContextIntoDelegation", () => {
	it("injects team_spawn task context", () => {
		const input = { task: "investigate this" };
		const changed = injectAdaContextIntoDelegation("team_spawn", input, makeArtifact({ data: { root_cause: "x" } }), "/tmp/art-1");

		expect(changed).toBe(true);
		expect(input.task).toContain("Active ADA artifact: art-1");
		expect(input.task).toContain("Artifact folder: /tmp/art-1/");
		expect(input.task).toContain("ada_get with id=\"art-1\"");
		expect(input.task).toContain("Always use this artifact");
		expect(input.task).toContain("Save requested result files inside the artifact folder");
		expect(input.task).toContain("Use ada_record when you need to persist structured facts");
		expect(input.task).toContain("Available data keys: root_cause");
	});

	it("injects namespaced team_spawn task context", () => {
		const input = { task: "investigate this" };

		expect(injectAdaContextIntoDelegation("functions.team_spawn", input, makeArtifact(), "/tmp/art-1")).toBe(true);
		expect(input.task).toContain("Active ADA artifact: art-1");
	});

	it("injects wrapped team_spawn calls", () => {
		const input = {
			tool_uses: [
				{ recipient_name: "functions.team_spawn", parameters: { task: "investigate" } },
				{ recipient_name: "functions.bash", parameters: { command: "pwd" } },
			],
		};

		expect(injectAdaContextIntoDelegation("multi_tool_use.parallel", input, makeArtifact(), "/tmp/art-1")).toBe(true);
		expect(input.tool_uses[0].parameters.task).toContain("Active ADA artifact: art-1");
		expect(input.tool_uses[1].parameters.command).toBe("pwd");
	});

	it("does not duplicate context for the same artifact", () => {
		const input = { task: "investigate this" };
		const artifact = makeArtifact();

		expect(injectAdaContextIntoDelegation("team_spawn", input, artifact, "/tmp/art-1")).toBe(true);
		const once = input.task;
		expect(injectAdaContextIntoDelegation("team_spawn", input, artifact, "/tmp/art-1")).toBe(false);
		expect(input.task).toBe(once);
	});

	it("injects subagent single-task context", () => {
		const input = { agent: "reviewer", task: "review this" };

		expect(injectAdaContextIntoDelegation("subagent", input, makeArtifact(), "/tmp/art-1")).toBe(true);
		expect(input.task).toContain("Active ADA artifact: art-1");
	});

	it("injects subagent parallel task context without touching metadata", () => {
		const input = {
			tasks: [
				{ agent: "reviewer", task: "review", cwd: "/repo" },
				{ agent: "tester", task: "test", cwd: "/repo" },
			],
		};

		expect(injectAdaContextIntoDelegation("subagent", input, makeArtifact(), "/tmp/art-1")).toBe(true);
		expect(input.tasks[0].task).toContain("Active ADA artifact: art-1");
		expect(input.tasks[1].task).toContain("Active ADA artifact: art-1");
		expect(input.tasks[0].agent).toBe("reviewer");
		expect(input.tasks[0].cwd).toBe("/repo");
	});

	it("injects every subagent chain step", () => {
		const input = {
			chain: [
				{ agent: "planner", task: "plan" },
				{ agent: "builder", task: "build from {previous}" },
			],
		};

		expect(injectAdaContextIntoDelegation("subagent", input, makeArtifact(), "/tmp/art-1")).toBe(true);
		expect(input.chain[0].task).toContain("Active ADA artifact: art-1");
		expect(input.chain[1].task).toContain("Active ADA artifact: art-1");
	});

	it("leaves subagent list mode unchanged", () => {
		const input = {};

		expect(injectAdaContextIntoDelegation("subagent", input, makeArtifact(), "/tmp/art-1")).toBe(false);
		expect(input).toEqual({});
	});

	it("leaves unknown tools and non-string tasks unchanged", () => {
		const unknown = { task: "x" };
		const invalid = { task: 123 };

		expect(injectAdaContextIntoDelegation("bash", unknown, makeArtifact(), "/tmp/art-1")).toBe(false);
		expect(injectAdaContextIntoDelegation("team_spawn", invalid, makeArtifact(), "/tmp/art-1")).toBe(false);
		expect(unknown.task).toBe("x");
		expect(invalid.task).toBe(123);
	});
});
