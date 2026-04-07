/**
 * ADA Helpers — disk I/O, state persistence, artifact discovery.
 *
 * Storage layout: artifacts/{slug}/artifact.json
 * Each artifact gets its own subfolder for future extensibility (logs, data, etc.)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ADAState, Artifact } from "./types.js";
import { ARTIFACTS_DIR } from "./types.js";

// ─── File Locking ───────────────────────────────────────────────────
// Simple lockfile-based mutex for concurrent artifact writes.
// Agents wait and retry until the lock is available.

const LOCK_TIMEOUT_MS = 10_000; // max wait before giving up
const LOCK_RETRY_MS = 50; // retry interval
const LOCK_STALE_MS = 30_000; // stale lock cleanup

function lockPath(id: string): string {
	return join(artifactDir(id), "artifact.lock");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire a lock on the artifact. Waits up to LOCK_TIMEOUT_MS. */
export async function acquireLock(id: string): Promise<void> {
	const lock = lockPath(id);
	const dir = artifactDir(id);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const start = Date.now();
	while (Date.now() - start < LOCK_TIMEOUT_MS) {
		try {
			// O_EXCL: fails if file exists — atomic create-or-fail
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return; // acquired
		} catch {
			// Lock exists — check if stale
			if (existsSync(lock)) {
				try {
					const stat = statSync(lock);
					if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
						try { unlinkSync(lock); } catch { /* race ok */ }
						continue;
					}
				} catch { /* stat failed, retry */ }
			}
			await sleep(LOCK_RETRY_MS);
		}
	}
	// Timeout — check if the lock holder is still alive via PID
	try {
		const pid = parseInt(readFileSync(lock, "utf-8").trim(), 10);
		if (pid && !isProcessAlive(pid)) {
			// Dead process left a stale lock -- safe to take over
			try { unlinkSync(lock); } catch { /* race ok */ }
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return;
		}
	} catch { /* lock disappeared or unreadable, retry once */ }

	// Last resort: try one more atomic create
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		return;
	} catch {
		// Genuine contention -- proceed without lock rather than deadlock.
		// The write is still atomic (tmp + rename) so worst case is a lost update.
	}
}

/** Check if a process is still running. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 = test if process exists
		return true;
	} catch {
		return false;
	}
}

/** Release the artifact lock. */
export function releaseLock(id: string): void {
	try { unlinkSync(lockPath(id)); } catch { /* ok */ }
}

/** Turn a title into a filesystem-safe slug. */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/** Get the directory path for an artifact by its ID (slug). */
export function artifactDir(id: string): string {
	return join(ARTIFACTS_DIR, id);
}

/** Get the JSON file path for an artifact. */
export function artifactFilePath(id: string): string {
	return join(ARTIFACTS_DIR, id, "artifact.json");
}

/** Ensure the artifacts root directory exists. */
export function ensureArtifactsDir(): void {
	if (!existsSync(ARTIFACTS_DIR)) {
		mkdirSync(ARTIFACTS_DIR, { recursive: true });
	}
}

/** Write an artifact to its subfolder on disk (atomic: write tmp + rename). */
export function writeArtifactToDisk(artifact: Artifact): void {
	const dir = artifactDir(artifact.id);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const filePath = artifactFilePath(artifact.id);
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf-8");
	renameSync(tmpPath, filePath);
}

/** Read an artifact from disk by ID (slug). Returns null if not found. */
export function readArtifactFromDisk(id: string): Artifact | null {
	const filePath = artifactFilePath(id);
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Artifact;
	} catch {
		return null;
	}
}

/** List all artifacts on disk, sorted by updated_at descending. */
export function listArtifactsFromDisk(): Artifact[] {
	ensureArtifactsDir();
	const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
	const artifacts: Artifact[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const filePath = join(ARTIFACTS_DIR, entry.name, "artifact.json");
		if (!existsSync(filePath)) continue;
		try {
			const raw = readFileSync(filePath, "utf-8");
			artifacts.push(JSON.parse(raw) as Artifact);
		} catch {
			// Skip corrupt files
		}
	}
	return artifacts.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/** Persist current state to the session via appendEntry. */
export function persistState(pi: ExtensionAPI, state: ADAState): void {
	pi.appendEntry({
		type: "custom",
		customType: "ada-artifact",
		data: {
			artifact: state.artifact
				? {
						id: state.artifact.id,
						status: state.artifact.status,
						title: state.artifact.title,
						dataKeys: Object.keys(state.artifact.data).length,
						checkpoints: state.artifact.checkpoints.length,
						session_id: state.artifact.session_id,
					}
				: null,
		},
	});
}

/**
 * Clean up completed artifact subfolders older than maxAgeDays.
 * Active and paused artifacts are never cleaned.
 */
export function cleanupOldArtifacts(maxAgeDays: number = 7): number {
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const all = listArtifactsFromDisk();
	let cleaned = 0;
	for (const a of all) {
		if (a.status === "completed" && new Date(a.updated_at).getTime() < cutoff) {
			const dir = artifactDir(a.id);
			try {
				rmSync(dir, { recursive: true, force: true });
				cleaned++;
			} catch {
				// Ignore cleanup errors
			}
		}
	}
	return cleaned;
}
