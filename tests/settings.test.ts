import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadSettings, saveSettings } from "../settings.js";
import { ADA_ROOT } from "../types.js";

const SETTINGS_PATH = join(ADA_ROOT, "settings.json");

afterEach(() => {
	if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
});

describe("loadSettings", () => {
	it("returns defaults when settings.json does not exist", () => {
		const s = loadSettings();
		expect(s.constraint_tokens).toBe(200_000);
		expect(s.restart_mode).toBe("ask");
		expect(s.input_warn_pct).toBeCloseTo(0.10);
		expect(s.command_enabled).toBe(true);
		expect(s.command).toContain("pi --no-session --thinking off --model anthropic/claude-haiku-4-5");
		expect(s.command).toContain("-ne");
		expect(s.command).toContain("-ns");
		expect(s.command).toContain("-nc");
		expect(s.command).toContain("shopify-proxy");
	});

	it("merges partial files with defaults", () => {
		writeFileSync(SETTINGS_PATH, JSON.stringify({ constraint_tokens: 50_000 }), "utf-8");
		const s = loadSettings();
		expect(s.constraint_tokens).toBe(50_000);
		expect(s.restart_mode).toBe("ask");
		expect(s.command_enabled).toBe(true);
	});

	it("falls back to defaults on corrupt JSON", () => {
		writeFileSync(SETTINGS_PATH, "{not json", "utf-8");
		const s = loadSettings();
		expect(s.constraint_tokens).toBe(200_000);
	});

	it("clamps invalid restart_mode to default", () => {
		writeFileSync(SETTINGS_PATH, JSON.stringify({ restart_mode: "bogus" }), "utf-8");
		const s = loadSettings();
		expect(s.restart_mode).toBe("ask");
	});

	it("preserves a valid restart_mode", () => {
		writeFileSync(SETTINGS_PATH, JSON.stringify({ restart_mode: "auto" }), "utf-8");
		const s = loadSettings();
		expect(s.restart_mode).toBe("auto");
	});

	it("preserves command field overrides", () => {
		writeFileSync(SETTINGS_PATH, JSON.stringify({ command: "pi --model whatever", command_enabled: false }), "utf-8");
		const s = loadSettings();
		expect(s.command).toBe("pi --model whatever");
		expect(s.command_enabled).toBe(false);
	});
});

describe("saveSettings", () => {
	it("round-trips through load", () => {
		const written = {
			constraint_tokens: 80_000,
			restart_mode: "auto" as const,
			input_warn_pct: 0.25,
			command: "pi --model some/other-model",
			command_enabled: false,
		};
		saveSettings(written);
		const back = loadSettings();
		expect(back).toEqual(written);
	});

	it("creates the settings directory if missing", () => {
		rmSync(ADA_ROOT, { recursive: true, force: true });
		const written = loadSettings();
		saveSettings(written);
		expect(existsSync(SETTINGS_PATH)).toBe(true);
	});
});
