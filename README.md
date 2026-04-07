# ADA -- Artifact Driven Agent

A [Pi](https://github.com/mariozechner/pi) extension that gives AI agents a persistent, structured workspace for iterative work.

When an agent is doing anything multi-step -- performance investigations, bug fixes, code reviews, planning sessions -- it creates an artifact: a living JSON document that serves as the source of truth for the entire task. The artifact survives across turns, sessions, and agent boundaries.

## Why

Without ADA, agents lose context between turns. They re-read the same files, re-discover the same findings, and forget what they already tried. ADA solves this by giving agents a structured place to accumulate knowledge as they work.

The artifact is not a log. It is a database for the task at hand. Agents store measurements, hypotheses, evidence, and state -- not "I looked at file X." Every iteration enriches the data. Every checkpoint marks real progress.

## How It Works

Each artifact has two parts:

**data** -- a free-form JSON object the agent owns completely. Structure it however the work demands: nested objects, arrays, measurements, people, questions, files. The agent reads it, updates it, queries specific keys, and builds on it every iteration.

**checkpoints** -- milestones that mark meaningful progress. Not a journal. Just the moments that matter: "baseline measured", "root cause found", "3/8 interviews complete".

Artifacts live on disk at `~/.pi/agent/artifacts/{slug}/artifact.json`. Each artifact gets its own folder where agents can also store reference files (evidence, drafts, exported data) alongside the main JSON.

### Context Management

ADA is designed to stay out of the way. The prompt injection is minimal: just the artifact title and ID (three lines). No data is loaded into context automatically. The agent controls what enters context by calling `ada_get` with specific keys. A massive artifact with 50 data keys does not bloat the context window.

### Session Binding

Artifacts belong to the session that created them. Different Pi sessions cannot auto-load each other's artifacts. The `/ada-resume` command is the explicit way to take ownership across sessions.

### Concurrent Access

Multiple agents (lead + spawned teammates) can write to the same artifact simultaneously. Writes are protected by a file-based mutex lock. Data is re-read from disk before every write, so no changes are lost.

## Tools

ADA registers six tools that the agent calls during work:

### ada_create

Start a new artifact. Give it a title and an optional type (`investigation`, `fix`, `review`, `planning`, `build`, `general`). Only one artifact can be active at a time.

```
ada_create({ title: "Checkout latency investigation", type: "investigation" })
```

### ada_update

Write key-value pairs into the artifact's data object. Shallow merge at the top level -- existing keys are overwritten, new keys are added. For nested updates, read the current value with `ada_get`, modify it, then write the whole key back.

```
ada_update({ data: { baseline_ms: 450, current_ms: 120, optimization: "index on user_id" } })
```

### ada_get

Targeted read. Pass specific keys to get just those values. Pass no keys to get the artifact header (title, type, status, available keys, checkpoints) without loading any data. This is the primary read tool -- it keeps context lean.

Spawned agents can pass an `id` parameter to connect to an artifact they were told about by the lead.

```
ada_get({ keys: ["baseline_ms", "attempts"] })
ada_get({})  // header only -- see what keys exist
ada_get({ id: "checkout-latency" })  // spawned agent connecting
```

### ada_read

Full load. Returns the entire artifact including all data and checkpoints. Use when resuming from another session or when you genuinely need the complete picture. Expensive on context -- prefer `ada_get` for normal work.

```
ada_read({})
```

### ada_checkpoint

Mark a milestone. One sentence about what was reached. These are progress breadcrumbs, not a journal.

```
ada_checkpoint({ note: "Root cause confirmed: missing index on orders table" })
```

### ada_close

Close the artifact. Use `completed` when work is done (artifact becomes read-only), or `paused` to resume later. Optionally include a summary.

```
ada_close({ status: "completed", summary: "Fixed N+1 query, p50 dropped from 450ms to 72ms" })
```

## Slash Commands

| Command | What it does |
|---------|--------------|
| `/ada-list` | List all artifacts with status, data keys, and last checkpoint |
| `/ada-resume` | Interactive picker to resume a paused or completed artifact |
| `/ada-resume <id>` | Connect to a specific artifact by ID, rebinding session ownership |

## Multi-Agent Support

When the lead agent spawns a teammate via `team_spawn` while an artifact is active, ADA automatically appends the artifact ID and folder path to the task prompt. The spawned agent:

1. Calls `ada_get` with the `id` parameter to connect
2. Reads current state to avoid duplicating work
3. Does its research or task
4. Calls `ada_update` to write findings directly into the shared workspace
5. Saves any long-form reference files into the artifact folder
6. Sends `team_message` to report back

The lead never needs to copy data from `/tmp` files or funnel results. Everything flows through the artifact.

## Data Structure Examples

There is no forced schema. Structure data for the work:

**Performance investigation:**
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

**Peer review cycle:**
```json
{
  "cycle": { "name": "Q2 2026", "start": "2026-04-06", "end": "2026-05-06" },
  "self_review": { "status": "done" },
  "interviews": {
    "alice": { "status": "done", "questions_done": 5, "evidence_file": "alice-evidence.md" },
    "bob": { "status": "in-progress", "questions_done": 2 },
    "charlie": { "status": "new" }
  }
}
```

**Bug investigation:**
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

## Installation

### From Git

```bash
git clone https://github.com/leop-shopify/ada.git ~/.pi/agent/extensions/ada
```

Pi loads extensions from `~/.pi/agent/extensions/` automatically. No configuration needed -- ADA registers its tools, commands, and event handlers on startup.

### From a Different Location

If you prefer to keep the code elsewhere (e.g., `~/src/ada-for-pi`), clone there and symlink:

```bash
git clone https://github.com/leop-shopify/ada.git ~/src/ada-for-pi
ln -s ~/src/ada-for-pi ~/.pi/agent/extensions/ada
```

### Updating

```bash
cd ~/.pi/agent/extensions/ada  # or wherever you cloned it
git pull
```

Restart Pi to pick up changes.

## Files

```
ada/
  index.ts      -- Extension wiring: state management, session events, prompt injection,
                   slash commands, nudge heuristic, team_spawn artifact injection
  tools.ts      -- Tool definitions: ada_create, ada_update, ada_get, ada_read,
                   ada_checkpoint, ada_close (with TUI renderers)
  types.ts      -- TypeScript types: Artifact, Checkpoint, ADAState, ArtifactStatus
  helpers.ts    -- Disk I/O: atomic writes (tmp + rename), file locking (mutex),
                   artifact discovery, cleanup of old completed artifacts
  SKILL.md      -- Agent-facing documentation: when to create artifacts, how to
                   structure data, how to work with spawned agents, what not to do
  README.md     -- This file
```

## Design Decisions

**Data, not journal.** The artifact holds structured data the agent works with, not a log of what happened. Agents store findings, measurements, and state -- not "I looked at file X."

**Targeted reads by default.** No data is auto-loaded into context. Agents use `ada_get` for specific keys. This means a 50-key artifact does not bloat the prompt.

**Atomic writes.** Every write goes through a temp file + rename to prevent corruption. A file-based mutex prevents concurrent writes from clobbering each other.

**Session isolation.** Artifacts cannot leak across sessions. The only cross-session access is through the explicit `/ada-resume` command, which rebinds ownership.

**Nudge heuristic.** If the agent makes 4+ substantive tool calls in a turn without updating the artifact, ADA sends a gentle reminder. This prevents agents from doing work and forgetting to record it.

**Auto-cleanup.** Completed artifacts older than 7 days are automatically removed on session start.

## Requirements

- [Pi](https://github.com/mariozechner/pi) coding agent (the extension API this is built on)
- Node.js (Pi's runtime)

## License

MIT
