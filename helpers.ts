/**
 * ADA Helpers — disk I/O, state persistence, artifact discovery.
 *
 * Storage layout:
 *   New: artifacts/{yyyymmdd}/{slug}/artifact.json
 *   Legacy: artifacts/{slug}/artifact.json (still supported for reads)
 * Each artifact gets its own subfolder for future extensibility (logs, data, etc.)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ADAState, Artifact } from "./types.js";
import { ARTIFACTS_DIR } from "./types.js";

// ─── Jewelry Tiers ──────────────────────────────────────────────────
// Complexity = data keys + checkpoints + inputs. More complex artifacts get fancier gems.

const JEWELRY_TIERS = [
	{ emoji: "\u{1FAA8}", min: 0 },   // rock
	{ emoji: "\u{1F52E}", min: 5 },   // crystal ball
	{ emoji: "\u{1F48E}", min: 15 },  // gem stone
	{ emoji: "\u{2B50}", min: 30 },   // star (legendary)
] as const;

/** Pick a jewelry emoji based on artifact complexity. */
export function jewelryForComplexity(dataKeys: number, checkpoints: number, inputs: number = 0): string {
	const complexity = dataKeys + checkpoints + inputs;
	let emoji: string = JEWELRY_TIERS[0].emoji;
	for (const tier of JEWELRY_TIERS) {
		if (complexity >= tier.min) emoji = tier.emoji;
	}
	return emoji;
}

/** Format bytes into human-readable size (B, KB, MB). */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Get artifact.json file size in bytes. Returns 0 if not found. */
export function getArtifactFileSize(id: string): number {
	const filePath = artifactFilePath(id);
	try {
		return statSync(filePath).size;
	} catch {
		return 0;
	}
}

/** Relative time since a date, compact format. */
export function timeSince(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

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

/**
 * Normalize a title for similarity comparison.
 * Strips noise words, punctuation, numbers, and date-like fragments.
 */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")       // strip punctuation
		.replace(/\b(the|a|an|and|or|for|of|in|on|at|to|by|is|it|its|with|from)\b/g, "") // noise words
		.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi, "")          // month names
		.replace(/\b\d{1,4}\b/g, "")          // standalone numbers (dates, IDs kept only if long)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Find existing artifacts whose title is similar to the proposed one.
 * Returns artifacts that share >60% of normalized words with the input.
 * Used to prevent near-duplicate creation.
 */
export function findSimilarArtifacts(title: string, exclude?: string): Array<{ artifact: Artifact; similarity: number }> {
	const all = listArtifactsFromDisk();
	const normInput = normalizeTitle(title);
	const inputWords = new Set(normInput.split(" ").filter(Boolean));
	if (inputWords.size === 0) return [];

	const results: Array<{ artifact: Artifact; similarity: number }> = [];

	for (const a of all) {
		if (exclude && a.id === exclude) continue;
		const normExisting = normalizeTitle(a.title);
		const existingWords = new Set(normExisting.split(" ").filter(Boolean));
		if (existingWords.size === 0) continue;

		// Jaccard similarity: intersection / union
		let intersection = 0;
		for (const w of inputWords) {
			if (existingWords.has(w)) intersection++;
		}
		const union = new Set([...inputWords, ...existingWords]).size;
		const similarity = union > 0 ? intersection / union : 0;

		if (similarity >= 0.5) {
			results.push({ artifact: a, similarity });
		}
	}

	return results.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Resolve an existing artifact's directory on disk.
 * Checks new-style date-prefixed paths (artifacts/yyyymmdd/slug/) first,
 * then falls back to old-style flat paths (artifacts/slug/).
 * Returns null if the artifact doesn't exist anywhere.
 */
export function resolveArtifactDir(id: string): string | null {
	ensureArtifactsDir();
	try {
		const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
		// Check new-style: artifacts/yyyymmdd/slug/
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue;
			const candidate = join(ARTIFACTS_DIR, entry.name, id, "artifact.json");
			if (existsSync(candidate)) return join(ARTIFACTS_DIR, entry.name, id);
		}
		// Check old-style: artifacts/slug/
		const oldStyle = join(ARTIFACTS_DIR, id, "artifact.json");
		if (existsSync(oldStyle)) return join(ARTIFACTS_DIR, id);
	} catch { /* dir doesn't exist yet */ }
	return null;
}

/** Generate a new-style date-prefixed directory for artifact creation. */
export function newArtifactDir(id: string): string {
	const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return join(ARTIFACTS_DIR, today, id);
}

/**
 * Get the directory path for an artifact by its ID (slug).
 * Resolves to the existing location (old or new style) if found,
 * otherwise returns a new-style date-prefixed path.
 */
export function artifactDir(id: string): string {
	return resolveArtifactDir(id) ?? newArtifactDir(id);
}

/** Get the JSON file path for an artifact. */
export function artifactFilePath(id: string): string {
	return join(artifactDir(id), "artifact.json");
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

/** List all artifacts on disk, sorted by updated_at descending.
 *  Scans both old-style (artifacts/slug/) and new-style (artifacts/yyyymmdd/slug/) layouts.
 */
export function listArtifactsFromDisk(): Artifact[] {
	ensureArtifactsDir();
	const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
	const artifacts: Artifact[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		if (/^\d{8}$/.test(entry.name)) {
			// New-style date dir: scan subdirectories for artifact.json
			const datePath = join(ARTIFACTS_DIR, entry.name);
			let subEntries: Dirent[];
			try { subEntries = readdirSync(datePath, { withFileTypes: true }); } catch { continue; }
			for (const sub of subEntries) {
				if (!sub.isDirectory()) continue;
				const filePath = join(datePath, sub.name, "artifact.json");
				if (!existsSync(filePath)) continue;
				try {
					const raw = readFileSync(filePath, "utf-8");
					const a = JSON.parse(raw) as Artifact;
					if (!seen.has(a.id)) { seen.add(a.id); artifacts.push(a); }
				} catch { /* skip corrupt */ }
			}
		} else {
			// Old-style flat dir: artifacts/slug/artifact.json
			const filePath = join(ARTIFACTS_DIR, entry.name, "artifact.json");
			if (!existsSync(filePath)) continue;
			try {
				const raw = readFileSync(filePath, "utf-8");
				const a = JSON.parse(raw) as Artifact;
				if (!seen.has(a.id)) { seen.add(a.id); artifacts.push(a); }
			} catch { /* skip corrupt */ }
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
						title: state.artifact.title,
						dataKeys: Object.keys(state.artifact.data).length,
						checkpoints: state.artifact.checkpoints.length,
					}
				: null,
		},
	});
}

/**
 * Clean up artifact subfolders older than maxAgeDays.
 * Only removes artifacts not updated within the cutoff.
 * Also removes empty date directories after cleanup.
 */
export function cleanupOldArtifacts(maxAgeDays: number = 7): number {
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const all = listArtifactsFromDisk();
	let cleaned = 0;
	for (const a of all) {
		if (new Date(a.updated_at).getTime() < cutoff) {
			const dir = artifactDir(a.id);
			try {
				rmSync(dir, { recursive: true, force: true });
				cleaned++;
			} catch {
				// Ignore cleanup errors
			}
		}
	}
	// Remove empty date directories left behind after cleanup
	try {
		const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue;
			const datePath = join(ARTIFACTS_DIR, entry.name);
			try {
				const contents = readdirSync(datePath);
				if (contents.length === 0) rmSync(datePath, { recursive: true, force: true });
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	return cleaned;
}
