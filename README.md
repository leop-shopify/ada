# ADA -- Artifact Driven Agent

A [Pi](https://github.com/mariozechner/pi) extension that gives AI agents a persistent, structured workspace for iterative work.

When an agent is doing anything multi-step -- performance investigations, bug fixes, code reviews, planning sessions -- it creates an artifact: a living JSON document that serves as the source of truth for the entire task. The artifact survives across turns, sessions, and agent boundaries.

## Why

Without ADA, agents lose context between turns. They re-read the same files, re-discover the same findings, and forget what they already tried. ADA solves this by giving agents a structured place to accumulate knowledge as they work.

The artifact is not a log. It is a database for the task at hand. Agents store measurements, hypotheses, evidence, and state -- not "I looked at file X." Every iteration enriches the data. Every checkpoint marks real progress.

## How It Works

Each artifact has two parts:

**data** -- a free-form JSON object the agent owns completely. Structure it however the work demands: nested objects, arrays, measurements, people, questions, files. The agent reads it, updates it, queries specific keys, and builds on it every iteration.

**checkpoints** -- granular progress markers. Not a journal. Every edit/write, every test run, every important read finding, and every loaded information batch gets its own breadcrumb.

Artifacts live on disk at `~/.pi/agent/artifacts/{yyyymmdd}/{slug}/artifact.json`, organized by creation date. Each artifact gets its own folder where agents can also store reference files (evidence, drafts, exported data) alongside the main JSON. Legacy artifacts at the old flat path (`artifacts/{slug}/`) are read transparently for backward compatibility.

### Context Management

ADA is designed to stay out of the way. The prompt injection is minimal: just the artifact title and ID (three lines). No data is loaded into context automatically. The agent controls what enters context by calling `ada_get` with specific keys. A massive artifact with 50 data keys does not bloat the context window.

### Session Binding

Artifacts are shared across sessions. Different Pi sessions can resume the same artifact with `/ada-resume`, and spawned agents can connect with `ada_get` when given the artifact ID.

### Concurrent Access

Multiple agents (lead + spawned teammates) can write to the same artifact simultaneously. Writes are protected by a file-based mutex lock. Data is re-read from disk before every write, so no changes are lost.

## Installation

### Via Pi

```bash
pi install github.com/leop-shopify/ada
```

### From Git

```bash
git clone https://github.com/leop-shopify/ada.git ~/.pi/agent/extensions/ada
```

If you prefer to keep the code elsewhere, clone there and symlink:

```bash
git clone https://github.com/leop-shopify/ada.git ~/src/ada
ln -s ~/src/ada ~/.pi/agent/extensions/ada
```

Pi loads extensions from `~/.pi/agent/extensions/` automatically. No configuration needed.

## Tools

| Tool | Purpose |
|------|---------|
| `ada_create` | Start a new artifact with a title and type (investigation, fix, review, planning, build, general). One active artifact at a time. |
| `ada_update` | Write key-value pairs into the data object. Shallow merge -- existing keys overwritten, new keys added. |
| `ada_get` | Targeted read. Pass specific keys to get just those, or no keys to get the header (available keys, checkpoints). Spawned agents pass an `id` to connect. |
| `ada_read` | Full load. Returns everything. Use when resuming or when the complete picture is needed. Expensive on context. |
| `ada_checkpoint` | Mark granular progress. Use immediately after edit/write, after every test run, after important read findings, and after loaded information batches. |
## Slash Commands

| Command | What it does |
|---------|--------------|
| `/ada-resume` | Interactive picker to resume another artifact |
| `/ada-resume <id>` | Connect to a specific artifact by ID |
| `/ada-inspect` | Open a visual artifact inspector in the browser (interactive picker if no artifact is active) |
| `/ada-inspect <id>` | Inspect a specific artifact by ID |

## Multi-Agent Support

When the lead agent spawns a teammate via `team_spawn` while an artifact is active, ADA automatically appends the artifact ID and folder path to the task prompt. The spawned agent calls `ada_get` with the `id` parameter to connect, does its work, and writes findings directly into the shared workspace with `ada_update`. The lead never needs to copy data from temp files or funnel results.

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
    "alice": { "status": "done", "questions_done": 5 },
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

## Requirements

- [Pi](https://github.com/mariozechner/pi) coding agent
- Node.js (Pi's runtime)

## License

MIT
