import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ADAState, Artifact } from "./types.js";
import { ADA_ROOT, ARTIFACTS_DIR } from "./types.js";

const LOCKS_DIR = join(ADA_ROOT, "locks");

const JEWELRY_TIERS: Array<{ label: string; min: number }> = [
	{ label: ".", min: 0 },
	{ label: "*", min: 5 },
	{ label: "**", min: 15 },
	{ label: "***", min: 30 },
];

export function jewelryForComplexity(dataKeys: number, checkpoints: number): string {
	const complexity = dataKeys + checkpoints;
	let label = JEWELRY_TIERS[0].label;
	for (const tier of JEWELRY_TIERS) {
		if (complexity >= tier.min) label = tier.label;
	}
	return label;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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

export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\b(the|a|an|and|or|for|of|in|on|at|to|by|is|it|its|with|from)\b/g, "")
		.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi, "")
		.replace(/\b\d{1,4}\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

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

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

function lockPath(id: string): string {
	return join(LOCKS_DIR, `${id}.lock`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function acquireLock(id: string): Promise<void> {
	const lock = lockPath(id);
	if (!existsSync(LOCKS_DIR)) mkdirSync(LOCKS_DIR, { recursive: true });

	const start = Date.now();
	while (Date.now() - start < LOCK_TIMEOUT_MS) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return;
		} catch {
			if (existsSync(lock)) {
				try {
					const stat = statSync(lock);
					if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
						try { unlinkSync(lock); } catch {  }
						continue;
					}
				} catch {  }
			}
			await sleep(LOCK_RETRY_MS);
		}
	}

	try {
		const pid = parseInt(readFileSync(lock, "utf-8").trim(), 10);
		if (pid && !isProcessAlive(pid)) {
			try { unlinkSync(lock); } catch {  }
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return;
		}
	} catch {  }

	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
	} catch {
	}
}

export function releaseLock(id: string): void {
	try { unlinkSync(lockPath(id)); } catch {  }
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function v2ArtifactDir(id: string, dateHint?: string): string {
	const date = dateHint ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return join(ARTIFACTS_DIR, date, id);
}

function resolveArtifactDir(id: string): string | null {
	ensureDir(ARTIFACTS_DIR);

	try {
		const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue;
			const candidate = join(ARTIFACTS_DIR, entry.name, id, "artifact.json");
			if (existsSync(candidate)) return join(ARTIFACTS_DIR, entry.name, id);
		}
	} catch {  }

	return null;
}

export function artifactDir(id: string): string {
	return resolveArtifactDir(id) ?? v2ArtifactDir(id);
}

export function readArtifactFromDisk(id: string): Artifact | null {
	const dir = resolveArtifactDir(id);
	if (!dir) return null;

	const filePath = join(dir, "artifact.json");
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Artifact;
	} catch {
		return null;
	}
}

export function writeArtifactToDisk(artifact: Artifact): void {
	const dir = artifactDir(artifact.id);
	ensureDir(dir);

	const filePath = join(dir, "artifact.json");
	const json = JSON.stringify(artifact, null, 2);
	artifact.size_bytes = Buffer.byteLength(json, "utf-8");

	const finalJson = JSON.stringify(artifact, null, 2);
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, finalJson, "utf-8");
	renameSync(tmpPath, filePath);
}

export function listArtifactsFromDisk(): Artifact[] {
	const artifacts: Artifact[] = [];
	const seen = new Set<string>();

	function scanDateDirs(baseDir: string): void {
		if (!existsSync(baseDir)) return;
		let entries: Dirent[];
		try { entries = readdirSync(baseDir, { withFileTypes: true }); } catch { return; }

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			if (/^\d{8}$/.test(entry.name)) {
				const datePath = join(baseDir, entry.name);
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
					} catch {  }
				}
			} else {
				const filePath = join(baseDir, entry.name, "artifact.json");
				if (!existsSync(filePath)) continue;
				try {
					const raw = readFileSync(filePath, "utf-8");
					const a = JSON.parse(raw) as Artifact;
					if (!seen.has(a.id)) { seen.add(a.id); artifacts.push(a); }
				} catch {  }
			}
		}
	}

	scanDateDirs(ARTIFACTS_DIR);

	return artifacts.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export function persistState(pi: ExtensionAPI, state: ADAState): void {
	pi.appendEntry("ada-artifact", {
		artifact: state.artifact
			? {
					id: state.artifact.id,
					title: state.artifact.title,
					dataKeys: Object.keys(state.artifact.data).length,
					checkpoints: state.artifact.checkpoints.length,
				}
			: null,
	});
}

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
			} catch {  }
		}
	}

	function cleanEmptyDateDirs(baseDir: string): void {
		if (!existsSync(baseDir)) return;
		try {
			const entries = readdirSync(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue;
				const datePath = join(baseDir, entry.name);
				try {
					const contents = readdirSync(datePath);
					if (contents.length === 0) rmSync(datePath, { recursive: true, force: true });
				} catch {  }
			}
		} catch {  }
	}

	cleanEmptyDateDirs(ARTIFACTS_DIR);

	return cleaned;
}
