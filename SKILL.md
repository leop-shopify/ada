# ADA -- Artifact Driven Agent

ADA gives you a persistent, structured workspace for any multi-step work. The artifact
is a living JSON document you enrich every iteration -- a database for the task at hand.
It survives across turns, sessions, and agent boundaries.

Artifacts are shared. Any session can resume any artifact. There is no session binding,
no lifecycle status, no closing. One artifact at a time. Use /ada-resume to switch.

## When to create an artifact

Any work that iterates: performance investigations, bug fixes, code reviews, planning
sessions, peer reviews, research projects. If you will make more than 3 tool calls
to get the job done, create an artifact.

## Core concept

The artifact has two parts:

**data** -- a free-form JSON object you own completely. Structure it however the work
demands. Nested objects, arrays, measurements, people, questions, files -- anything.
This is the substance. You read it, update it, query specific keys, and build on it
every iteration.

**checkpoints** -- granular progress markers that track every meaningful change.
For fix, build, and investigation work: one change, one test run, one checkpoint.
Never batch multiple changes into a single checkpoint. The trail must show what
each individual change did in isolation. For planning and review work, checkpoints
can be coarser (phase transitions, decisions made).

## Tools

`ada_create` -- Start a new artifact. Only works when no artifact is currently active.
If one exists, the tool blocks. Use /ada-resume to switch artifacts.

`ada_update` -- Write key-value pairs into data. Shallow merge at the top level.
For nested updates, use `ada_get` to read the current value, modify it, then write
the whole key back with `ada_update`.

`ada_get` -- Targeted read. Pass specific keys to get just those. Pass no keys to
get the header (title, type, available keys, checkpoints) without loading data.
Use this for normal work -- it keeps context lean. Spawned agents can pass an `id`
parameter to connect to an artifact they were told about by the lead.

`ada_read` -- Full load. Returns everything. Use when resuming from another session
or when you genuinely need the complete picture. Expensive on context.

`ada_checkpoint` -- Mark progress. One sentence about what was reached or changed.
For iterative work (fixes, builds, investigations): checkpoint after every change
and every test run. This is non-negotiable.

There is no ada_close. Artifacts do not close. To switch, use /ada-resume.

## The artifact folder

Each artifact lives in its own folder:

    ~/.pi/agent/artifacts/{slug}/artifact.json

You can write any file into this folder using the standard `write` tool. Reference
documents, research notes, interview transcripts, evidence files, exported data --
anything that supports the work belongs here. The folder is the artifact's workspace.

Example: for a peer review cycle, you might have:
- artifact.json (the structured data -- people, questions, responses, status)
- alice-evidence.md (gathered PR evidence for Alice's review)
- self-review-draft.md (working draft of the self-review)
- interview-questions.md (template questions used across all interviews)

The artifact's data object can reference these files by name. The agent or a spawned
agent can read them with the standard `read` tool. Everything stays together.

## Spawning agents with artifacts

When you spawn an agent to do work for an active artifact, include the artifact ID
and folder path in the task prompt. The spawned agent can read and update the artifact.

Example task prompt for the lead to use:

    "Research Alice's recent PRs and code activity for the peer review.
    Write your findings into the active artifact using ada_update.
    Artifact ID: q1-2026-peer-review-cycle
    Artifact folder: ~/.pi/agent/artifacts/q1-2026-peer-review-cycle/
    Use ada_get to check current state before writing.
    Save any long-form evidence as files in the artifact folder.
    Send a team_message when done with a one-line summary."

The spawned agent:
1. Calls `ada_get` with `id` parameter to connect to the artifact
2. Calls `ada_get` with specific keys to check current state
3. Does its research
4. Calls `ada_update` to write structured findings into data
5. Uses `write` to save reference files in the artifact folder if needed
6. Sends `team_message` with a brief summary when done

## Spawned agent guardrails (enforced in code)

Spawned agents have hard restrictions. These are enforced at TWO levels -- the tool
is not even registered for spawned agents (invisible), AND the execute function has
a belt-and-suspenders BLOCKED guard. No way to game it:

- `ada_create` -- NOT REGISTERED for spawned agents. The tool does not exist in
  their runtime. Even if somehow called, the execute guard blocks it. Spawned agents
  MUST use `ada_get` with the artifact ID from their task prompt to connect.

Spawned agents CAN use:
- `ada_get` -- to connect (with id) and read data
- `ada_update` -- to write findings into the shared artifact
- `ada_checkpoint` -- to mark progress milestones
- `ada_read` -- to load the full artifact when needed

The lead does NOT need to read /tmp files, copy data, or funnel results. The spawned
agent writes directly into the shared workspace. The lead calls `ada_get` to see
what the agent added.

Do NOT tell spawned agents to save results to /tmp when an artifact is active. The
artifact folder is the workspace. /tmp is for throwaway data with no artifact context.

## Context management

The prompt injection is minimal: just the artifact title and ID. No data is loaded
into context automatically. You control what enters context by calling `ada_get`
with specific keys. This means:

- A massive artifact with 50 data keys does not bloat your context
- You load only what you need for the current step
- Use `ada_get` (no keys) to orient: see what keys exist, read checkpoints
- Use `ada_get` (specific keys) to load the data you need right now
- Use `ada_read` only when resuming or when you need everything

## Concurrent access

Multiple agents can write to the same artifact. Writes are locked -- if two agents
call `ada_update` at the same time, one waits for the other to finish. Data is
re-read from disk before every write so no changes are lost.

## How to structure data

There is no forced schema. Structure data for the work:

Performance investigation:
```json
{
  "endpoint": "/api/orders",
  "baseline": { "p50_ms": 120, "p99_ms": 450, "sample": 1000 },
  "attempts": [
    { "change": "index on user_id", "p50_ms": 85, "p99_ms": 210 },
    { "change": "eager load line_items", "p50_ms": 72, "p99_ms": 180 }
  ],
  "root_cause": "missing index + N+1 on line_items",
  "files_changed": ["order.rb", "migration.rb"]
}
```

Peer review cycle:
```json
{
  "cycle": { "name": "Q2 2026", "start": "2026-04-06", "end": "2026-05-06" },
  "self_review": { "status": "done", "review_id": 12345 },
  "interviews": {
    "alice": { "status": "done", "questions_done": 5, "evidence_file": "alice-evidence.md" },
    "bob": { "status": "paused", "paused_at": "Q3", "questions_done": 2 },
    "charlie": { "status": "new" }
  }
}
```

Bug investigation:
```json
{
  "symptom": "500 errors on /checkout after deploy",
  "hypothesis": "null user_id in new migration path",
  "evidence": { "error_count": 1200, "first_seen": "14:32 UTC", "trace_id": "abc123" },
  "root_cause": null,
  "files_investigated": ["checkout_controller.rb", "account.rb"],
  "files_to_fix": []
}
```

## Resuming across sessions

Artifacts are shared across sessions. Any session can resume any artifact:

1. Use `/ada-resume` to pick an artifact (interactive) or `/ada-resume {id}` for a specific one
2. Call `ada_read` to load the full picture and orient
3. From there, use `ada_get` for targeted reads as you work

If an artifact is already active when you resume, the current one is detached and the
new one becomes active. No closing needed.

## Artifacts are long-lived project trackers

An artifact tracks a PROJECT, not a single task within the project. When a project
has multiple issues, phases, or sub-tasks, they ALL belong in ONE artifact. Do not
create a new artifact for each sub-task.

Examples of WRONG behavior:
- Creating a new artifact when one already exists for the project
- Creating separate artifacts for each sub-issue of a parent issue

## Duplicate prevention (enforced in code)

The system has hard guards against duplicate artifacts. These are NOT advisory --
the tool will reject the call with a BLOCKED error:

1. **Exact slug collision**: If you try to create "PR Review Triage" and an artifact
   with slug `pr-review-triage` already exists, BLOCKED. Use /ada-resume instead.

2. **Similar title detection**: If you try to create "PR Review Triage - Apr 8" and
   an artifact called "PR Review Triage" exists, BLOCKED. The system compares
   normalized titles (stripping dates, noise words, punctuation) and blocks at
   50% Jaccard similarity or higher.

3. **Spawned agent creation**: Spawned agents cannot create artifacts. The tool is
   not even registered in their runtime.

If you get BLOCKED, the error message tells you which existing artifact to resume.
Use /ada-resume <id> to switch to it.

## Checkpoint discipline

Checkpoints are granular. Every meaningful discovery, every change, every test run
gets its own checkpoint. This applies to ALL artifact types and ALL agents.

### For fix and build work:

1. Make a change (edit a file, apply a fix, modify config)
2. Run the test or verification
3. Checkpoint with: what you changed, the test result, what changed from the previous run
4. If the test fails: note the new error before moving to the next change

Good: "Fix 1: changed nav selector from locator('nav').first() to
getByRole('navigation', {name: /settings menu/i}). Test run: 6 more subpages pass,
new failure at Gift cards link."

Bad: "Applied fixes 1, 2, and 3. Tests pass now."

### For research and investigation work:

1. Search for something (grokt_search, file read, API call)
2. Find something meaningful (a model, a consumer, a pattern, a connection)
3. Checkpoint with: what you searched for, what you found, how it connects
4. Move to the next search

Good: "Found Handle model in app/models/handle.rb -- GlobalDbRecord, belongs_to
:resource (polymorphic). Broker includes Handle::ResourceConcerns, giving it
has_many :handles."

Good: "Identified 3 consumers of broker_handle: StorefrontRenderer (GraphQL),
ShopMobileApp (REST API), AdminWeb (internal). Each uses Handle.find_by_handle."

Bad: "Mapped the full broker_handle architecture." (too coarse -- what did you find?)

Bad: "Searched several files and found the data flow." (batched -- checkpoint each find)

The rule of thumb: if you called 2+ substantive tools (search, read, query) since
your last checkpoint, you are overdue. Checkpoint what you learned before continuing.

### Universal rules:

- This applies to the lead AND to spawned agents. No exceptions, no batching.
- Even when you can see the next step, checkpoint the current finding first.
- The checkpoint records what THIS step accomplished, not the overall status.

## What NOT to do

- Do not use the artifact as a journal. "I looked at file X" is not useful data.
  Store what you found, not what you did.
- Do not dump entire file contents into data keys. Reference files by path instead
  and store them in the artifact folder.
- Do not load the full artifact every turn. Use ada_get for targeted reads.
- Do not create an artifact for simple one-shot tasks. It is for iterative work.
- Do not store transient state that changes every turn. Data should accumulate and
  enrich, not churn.
- Do not tell spawned agents to save to /tmp when an artifact is active. The artifact
  folder is the workspace.
- Do not create a new artifact to amend an existing one. Update the original.
- Do not create "Issue 4691 Investigation" today and "Issue 4691 Investigation v2"
  tomorrow. Resume the original.
- Do not add dates to artifact titles. "PR Review Triage" not "PR Review Triage - Apr 8".
