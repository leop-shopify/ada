#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const HOME = process.env.HOME;
const ADA_ROOT = path.join(HOME, ".pi", "agent", "ada");
const ARTIFACTS_DIR = path.join(ADA_ROOT, "artifacts");
const LOCKS_DIR = path.join(ADA_ROOT, "locks");
const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 50;

function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleepSync(ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {  }
}

function isProcessAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPath(id) {
	return path.join(LOCKS_DIR, `${id}.lock`);
}

function acquireLock(id) {
	ensureDir(LOCKS_DIR);
	const lock = lockPath(id);
	const start = Date.now();
	while (Date.now() - start < LOCK_TIMEOUT_MS) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
			return;
		} catch {
			if (fs.existsSync(lock)) {
				try {
					const stat = fs.statSync(lock);
					if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
						try { fs.unlinkSync(lock); } catch {  }
						continue;
					}
					const pid = parseInt(fs.readFileSync(lock, "utf-8").trim(), 10);
					if (pid && !isProcessAlive(pid)) {
						try { fs.unlinkSync(lock); } catch {  }
						continue;
					}
				} catch {  }
			}
			sleepSync(LOCK_RETRY_MS);
		}
	}
	try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); } catch {  }
}

function releaseLock(id) {
	try { fs.unlinkSync(lockPath(id)); } catch {  }
}

function todayDateStamp() {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}${m}${day}`;
}

function localIsoWithTz(d) {
	const date = d ?? new Date();
	const offset = -date.getTimezoneOffset();
	const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
	const m = String(Math.abs(offset) % 60).padStart(2, "0");
	const sign = offset >= 0 ? "+" : "-";
	return date.toISOString().replace("Z", `${sign}${h}:${m}`);
}

function v2ArtifactDir(id, dateHint) {
	const date = dateHint ?? todayDateStamp();
	return path.join(ARTIFACTS_DIR, date, id);
}

function resolveArtifactDir(id) {
	ensureDir(ARTIFACTS_DIR);
	try {
		for (const entry of fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue;
			const candidate = path.join(ARTIFACTS_DIR, entry.name, id, "artifact.json");
			if (fs.existsSync(candidate)) return path.join(ARTIFACTS_DIR, entry.name, id);
		}
	} catch {  }
	return null;
}

function readArtifact(id) {
	const dir = resolveArtifactDir(id);
	if (!dir) return null;
	const file = path.join(dir, "artifact.json");
	if (!fs.existsSync(file)) return null;
	try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function writeArtifactAtomic(artifact) {
	const dir = resolveArtifactDir(artifact.id) ?? v2ArtifactDir(artifact.id, artifact.created_at?.slice(0, 10).replace(/-/g, ""));
	ensureDir(dir);
	const file = path.join(dir, "artifact.json");
	const probe = JSON.stringify(artifact, null, 2);
	artifact.size_bytes = Buffer.byteLength(probe, "utf-8");
	const json = JSON.stringify(artifact, null, 2);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, json, "utf-8");
	fs.renameSync(tmp, file);
}

function listAll() {
	const out = [];
	const seen = new Set();
	function scan(base) {
		if (!fs.existsSync(base)) return;
		let entries;
		try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (/^\d{8}$/.test(e.name)) {
				const dp = path.join(base, e.name);
				let subs;
				try { subs = fs.readdirSync(dp, { withFileTypes: true }); } catch { continue; }
				for (const s of subs) {
					if (!s.isDirectory()) continue;
					const f = path.join(dp, s.name, "artifact.json");
					if (!fs.existsSync(f)) continue;
					try {
						const a = JSON.parse(fs.readFileSync(f, "utf-8"));
						if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
					} catch {  }
				}
			} else {
				const f = path.join(base, e.name, "artifact.json");
				if (!fs.existsSync(f)) continue;
				try {
					const a = JSON.parse(fs.readFileSync(f, "utf-8"));
					if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
				} catch {  }
			}
		}
	}
	scan(ARTIFACTS_DIR);
	return out;
}

function cmdTrackInput(id, title) {
	acquireLock(id);
	try {
		let a = readArtifact(id);
		const now = localIsoWithTz();
		if (!a) {
			a = {
				id,
				title: title || id,
				type: "general",
				created_at: now,
				updated_at: now,
				size_bytes: 0,
				first_input_tokens: null,
				cursor: { last_processed_entry_id: null },
				data: {},
				inputs: [],
				checkpoints: [],
			};
		}
		if (!Array.isArray(a.inputs)) a.inputs = [];
		if (!Array.isArray(a.checkpoints)) a.checkpoints = [];
		a.updated_at = now;
		writeArtifactAtomic(a);
	} finally {
		releaseLock(id);
	}
}

function cmdSetMeta(id, patchJson) {
	const patch = JSON.parse(patchJson);
	acquireLock(id);
	try {
		const a = readArtifact(id);
		if (!a) return;
		Object.assign(a, patch);
		a.updated_at = localIsoWithTz();
		writeArtifactAtomic(a);
	} finally {
		releaseLock(id);
	}
}

function cmdCleanupOld(maxAgeDays) {
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const a of listAll()) {
		if (new Date(a.updated_at).getTime() < cutoff) {
			const dir = resolveArtifactDir(a.id);
			if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
		}
	}
	if (!fs.existsSync(ARTIFACTS_DIR)) return;
	try {
		for (const e of fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })) {
			if (!e.isDirectory() || !/^\d{8}$/.test(e.name)) continue;
			const dp = path.join(ARTIFACTS_DIR, e.name);
			try {
				if (fs.readdirSync(dp).length === 0) fs.rmSync(dp, { recursive: true, force: true });
			} catch {  }
		}
	} catch {  }
}

function readStdinSync() {
	const chunks = [];
	const buf = Buffer.alloc(65536);
	while (true) {
		try {
			const n = fs.readSync(0, buf, 0, buf.length, null);
			if (n === 0) break;
			chunks.push(Buffer.from(buf.subarray(0, n)));
		} catch { break; }
	}
	return Buffer.concat(chunks).toString("utf-8");
}

const sub = process.argv[2];

if (sub === "track-input") {
	const id = process.argv[3];
	const title = process.argv[4] ?? "";
	readStdinSync();
	cmdTrackInput(id, title);
} else if (sub === "set-meta") {
	const id = process.argv[3];
	const patchJson = process.argv[4];
	cmdSetMeta(id, patchJson);
} else if (sub === "cleanup-old") {
	const days = parseInt(process.argv[3] ?? "7", 10);
	cmdCleanupOld(days);
} else {
	process.stderr.write(`Unknown subcommand: ${sub}\n`);
	process.exit(2);
}
