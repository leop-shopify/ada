import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ADASettings } from "./types.js";
import { ADA_ROOT } from "./types.js";

const SETTINGS_PATH = join(ADA_ROOT, "settings.json");

const DEFAULTS: ADASettings = {
	constraint_tokens: 200_000,
	restart_mode: "ask",
	input_warn_pct: 0.10,
	command: "pi --no-session --thinking off --model anthropic/claude-haiku-4-5 -ne -ns -nc -e ~/.pi/agent/extensions/shopify-proxy",
	command_enabled: true,
};

export function loadSettings(): ADASettings {
	if (!existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(SETTINGS_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ADASettings>;
		return {
			constraint_tokens: parsed.constraint_tokens ?? DEFAULTS.constraint_tokens,
			restart_mode: parsed.restart_mode === "auto" ? "auto" : DEFAULTS.restart_mode,
			input_warn_pct: parsed.input_warn_pct ?? DEFAULTS.input_warn_pct,
			command: parsed.command ?? DEFAULTS.command,
			command_enabled: parsed.command_enabled ?? DEFAULTS.command_enabled,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(settings: ADASettings): void {
	if (!existsSync(ADA_ROOT)) mkdirSync(ADA_ROOT, { recursive: true });
	const json = JSON.stringify(settings, null, 2);
	const tmpPath = `${SETTINGS_PATH}.tmp`;
	writeFileSync(tmpPath, json, "utf-8");
	renameSync(tmpPath, SETTINGS_PATH);
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ada-settings", {
		description: "Configure ADA settings",
		handler: async (_args, ctx) => {
			let settings = loadSettings();

			const fields = () => [
				`constraint_tokens: ${settings.constraint_tokens}`,
				`restart_mode: ${settings.restart_mode}`,
				`input_warn_pct: ${settings.input_warn_pct}`,
				`command: ${settings.command}`,
				`command_enabled: ${settings.command_enabled}`,
				"Save and exit",
				"Cancel",
			];

			let changed = false;

			while (true) {
				const choice = await ctx.ui.select("ADA Settings", fields());
				if (!choice || choice === "Cancel") {
					if (changed) ctx.ui.notify("Changes discarded.", "info");
					return;
				}
				if (choice === "Save and exit") {
					if (changed) {
						saveSettings(settings);
						ctx.ui.notify("Settings saved.", "info");
					} else {
						ctx.ui.notify("No changes.", "info");
					}
					return;
				}

				if (choice.startsWith("constraint_tokens")) {
					const val = await ctx.ui.input("constraint_tokens", String(settings.constraint_tokens));
					if (val) {
						const num = parseInt(val, 10);
						if (!isNaN(num) && num > 0) {
							settings.constraint_tokens = num;
							changed = true;
						}
					}
				} else if (choice.startsWith("restart_mode")) {
					const val = await ctx.ui.select("restart_mode", ["auto", "ask"]);
					if (val === "auto" || val === "ask") {
						settings.restart_mode = val;
						changed = true;
					}
				} else if (choice.startsWith("input_warn_pct")) {
					const val = await ctx.ui.input("input_warn_pct (0-1)", String(settings.input_warn_pct));
					if (val) {
						const num = parseFloat(val);
						if (!isNaN(num) && num >= 0 && num <= 1) {
							settings.input_warn_pct = num;
							changed = true;
						}
					}
				} else if (choice.startsWith("command_enabled")) {
					const val = await ctx.ui.confirm("command_enabled", `Currently ${settings.command_enabled ? "enabled" : "disabled"}. Toggle?`);
					if (val) {
						settings.command_enabled = !settings.command_enabled;
						changed = true;
					}
				} else if (choice.startsWith("command")) {
					const val = await ctx.ui.input("command", settings.command);
					if (val) {
						settings.command = val;
						changed = true;
					}
				}
			}
		},
	});
}
