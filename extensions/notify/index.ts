/**
 * Notification Extension for Pi
 *
 * Sends native macOS notifications and plays sound alerts when Pi finishes tasks.
 *
 * Features:
 * - Native macOS Notification Center banner via osascript (safe argument passing)
 * - Sound alerts via macOS afplay (Glass, Hero, Ping, Tink, etc.)
 * - Contextual details: project / folder name, prompt summary, task elapsed time
 * - Outcome-aware: different sound/message on success vs error, skip on manual abort
 * - Configurable via `/notify` command and ~/.pi/agent/notify.json
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface NotifyConfig {
	enabled: boolean;
	soundEnabled: boolean;
	notificationEnabled: boolean;
	sound: string;
	errorSound: string;
	minDurationMs: number;
	notifyOnAbort: boolean;
	notifyInPrintMode: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = {
	enabled: true,
	soundEnabled: true,
	notificationEnabled: true,
	sound: "Glass",
	errorSound: "Basso",
	minDurationMs: 0,
	notifyOnAbort: false,
	notifyInPrintMode: false,
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "notify.json");

function loadConfig(): NotifyConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			return { ...DEFAULT_CONFIG, ...data };
		}
	} catch {
		// Ignore parse errors, fallback to default
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(config: NotifyConfig): void {
	try {
		const dir = path.dirname(CONFIG_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
	} catch (err) {
		console.error("Failed to save notify config:", err);
	}
}

function getAvailableSounds(): string[] {
	try {
		const files = fs.readdirSync("/System/Library/Sounds");
		return files
			.filter((f) => f.endsWith(".aiff"))
			.map((f) => path.basename(f, ".aiff"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [
			"Basso",
			"Blow",
			"Bottle",
			"Frog",
			"Funk",
			"Glass",
			"Hero",
			"Morse",
			"Ping",
			"Pop",
			"Purr",
			"Sosumi",
			"Submarine",
			"Tink",
		];
	}
}

function resolveSoundPath(soundName: string): string | null {
	if (path.isAbsolute(soundName) && fs.existsSync(soundName)) {
		return soundName;
	}
	const candidate = soundName.endsWith(".aiff") ? soundName : `${soundName}.aiff`;
	const sysPath = path.join("/System/Library/Sounds", candidate);
	if (fs.existsSync(sysPath)) {
		return sysPath;
	}
	return null;
}

function playSound(soundName: string): void {
	if (process.platform !== "darwin") return;
	const resolved = resolveSoundPath(soundName);
	if (!resolved) return;

	try {
		const proc = spawn("afplay", [resolved], {
			stdio: "ignore",
			detached: true,
		});
		proc.unref();
	} catch {
		// Ignore playback errors
	}
}

function stripControl(s: string): string {
	return s.replace(/[\x00-\x1f\x7f]/g, " ");
}

/**
 * Post via iTerm2's OSC 9 escape sequence. iTerm2 owns the notification, so clicking
 * it focuses the exact window/tab/pane that emitted it (no Script Editor).
 * Requires: iTerm2 → Settings → Profiles → Terminal → "Send notifications" for
 * escape-sequence-generated alerts (enabled by default).
 */
function sendITermNotification(title: string, subtitle: string, message: string): boolean {
	if (process.env.TERM_PROGRAM !== "iTerm.app" && !process.env.ITERM_SESSION_ID) return false;
	if (!process.stdout.isTTY) return false;
	const text = stripControl(`${title} · ${subtitle}: ${message}`);
	let seq = `\x1b]9;${text}\x07`;
	// tmux needs DCS passthrough (and `set -g allow-passthrough on`)
	if (process.env.TMUX) seq = `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
	try {
		process.stdout.write(seq);
		return true;
	} catch {
		return false;
	}
}

function sendMacNotification(title: string, subtitle: string, message: string): void {
	if (process.platform !== "darwin") return;
	if (sendITermNotification(title, subtitle, message)) return;

	// Use safe AppleScript argument parsing to prevent script injection
	const script = `on run argv
		if (count of argv) >= 3 and (item 3 of argv) is not "" then
			display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)
		else
			display notification (item 1 of argv) with title (item 2 of argv)
		end if
	end run`;

	try {
		const proc = spawn("osascript", ["-e", script, message, title, subtitle], {
			stdio: "ignore",
			detached: true,
		});
		proc.unref();
	} catch {
		// Ignore notification dispatch errors
	}
}

function formatDuration(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) {
		return `${sec}s`;
	}
	const mins = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${mins}m ${remainSec}s`;
}

function summarizePrompt(prompt?: string): string {
	if (!prompt) return "";
	// Take first non-empty line
	const firstLine = prompt
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0) || "";
	// Clean markdown or excess punctuation
	const cleaned = firstLine.replace(/^[#*`\- >\s]+/, "").trim();
	if (cleaned.length > 60) {
		return cleaned.slice(0, 57) + "...";
	}
	return cleaned;
}

export default function notifyExtension(pi: ExtensionAPI) {
	registerLoadedExtension("notify");
	let config = loadConfig();

	// Session runtime tracking
	let taskStartTime: number | null = null;
	let currentPrompt = "";
	let currentOutcome: "completed" | "aborted" | "error" = "completed";

	pi.on("before_agent_start", (event) => {
		taskStartTime = Date.now();
		currentPrompt = event.prompt;
		currentOutcome = "completed";
	});

	pi.on("agent_start", () => {
		if (!taskStartTime) {
			taskStartTime = Date.now();
			currentOutcome = "completed";
		}
	});

	pi.on("agent_before_settle", (event) => {
		currentOutcome = event.outcome;
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		if (!taskStartTime) return;
		const elapsedMs = Date.now() - taskStartTime;
		taskStartTime = null;

		// Reload config in case it changed externally
		config = loadConfig();

		// Check if enabled
		const enabled = process.env.PI_NOTIFY_ENABLED !== undefined
			? process.env.PI_NOTIFY_ENABLED !== "0" && process.env.PI_NOTIFY_ENABLED !== "false"
			: config.enabled;

		if (!enabled) return;

		// Guard mode: don't notify during headless/print/json runs unless specifically configured
		if (ctx.mode !== "tui" && ctx.mode !== "rpc" && !config.notifyInPrintMode) {
			return;
		}

		// Check outcome: if aborted, check if notifyOnAbort is set
		if (currentOutcome === "aborted" && !config.notifyOnAbort) {
			return;
		}

		// Check minimum duration threshold
		if (elapsedMs < config.minDurationMs) {
			return;
		}

		const promptSummary = summarizePrompt(currentPrompt);
		const durationText = formatDuration(elapsedMs);

		// Resolve subtitle: session name or folder name
		const dirName = path.basename(ctx.cwd || process.cwd()) || "Pi";
		const sessionName = ctx.sessionManager?.getSessionName?.();
		const subtitle = sessionName ? `${sessionName} (${dirName})` : dirName;

		const isError = currentOutcome === "error";
		const title = isError ? "Pi - Error" : "Pi - Done";

		let messageText: string;
		if (isError) {
			messageText = promptSummary
				? `Failed after ${durationText}: ${promptSummary}`
				: `Task failed after ${durationText}`;
		} else {
			messageText = promptSummary
				? `Done (${durationText}): ${promptSummary}`
				: `Task completed in ${durationText}`;
		}

		const activeSound = isError ? config.errorSound : (process.env.PI_NOTIFY_SOUND || config.sound);

		// Trigger sound
		if (config.soundEnabled && activeSound) {
			playSound(activeSound);
		}

		// Trigger macOS notification
		if (config.notificationEnabled) {
			sendMacNotification(title, subtitle, messageText);
		}
	});

	// Register /notify command
	pi.registerCommand("notify", {
		description: "Configure or test macOS completion notifications and sound alerts",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			config = loadConfig();
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0]?.toLowerCase();

			if (!subcmd || subcmd === "help" || subcmd === "status") {
				const statusLines = [
					`Notifications: ${config.enabled ? "ENABLED" : "DISABLED"}`,
					`Banner: ${config.notificationEnabled ? "ON" : "OFF"}`,
					`Sound: ${config.soundEnabled ? `ON (${config.sound})` : "OFF"}`,
					`Error Sound: ${config.errorSound}`,
					`Min Duration: ${config.minDurationMs > 0 ? `${config.minDurationMs / 1000}s` : "0s (always)"}`,
					"",
					"Usage:",
					"  /notify test              Send a test notification and play alert sound",
					"  /notify on                Enable notifications",
					"  /notify off               Disable notifications",
					"  /notify sound [name]      Choose or set completion sound (e.g. Glass, Hero, Ping)",
					"  /notify error-sound [name] Choose error sound (e.g. Basso)",
					"  /notify min <seconds>     Only notify if task takes longer than N seconds",
				];
				ctx.ui.notify(statusLines.join("\n"), "info");
				return;
			}

			if (subcmd === "test") {
				playSound(config.sound);
				sendMacNotification(
					"Pi - Done",
					path.basename(ctx.cwd || process.cwd()),
					`Test notification (${config.sound} sound)`
				);
				ctx.ui.notify(`Test notification sent with sound "${config.sound}".`, "info");
				return;
			}

			if (subcmd === "on") {
				config.enabled = true;
				saveConfig(config);
				ctx.ui.notify("Notifications enabled.", "info");
				return;
			}

			if (subcmd === "off") {
				config.enabled = false;
				saveConfig(config);
				ctx.ui.notify("Notifications disabled.", "info");
				return;
			}

			if (subcmd === "sound") {
				const soundName = parts[1];
				const sounds = getAvailableSounds();

				if (soundName) {
					// Direct set
					const match = sounds.find((s) => s.toLowerCase() === soundName.toLowerCase());
					const selected = match || soundName;
					config.sound = selected;
					saveConfig(config);
					playSound(selected);
					ctx.ui.notify(`Sound set to "${selected}".`, "info");
					return;
				}

				// Interactive selector
				if (ctx.hasUI) {
					const choice = await ctx.ui.select("Choose notification sound:", sounds);
					if (choice) {
						config.sound = choice;
						saveConfig(config);
						playSound(choice);
						ctx.ui.notify(`Sound set to "${choice}".`, "info");
					}
					return;
				}

				ctx.ui.notify(`Available sounds: ${sounds.join(", ")}`, "info");
				return;
			}

			if (subcmd === "error-sound") {
				const soundName = parts[1];
				const sounds = getAvailableSounds();

				if (soundName) {
					const match = sounds.find((s) => s.toLowerCase() === soundName.toLowerCase());
					const selected = match || soundName;
					config.errorSound = selected;
					saveConfig(config);
					playSound(selected);
					ctx.ui.notify(`Error sound set to "${selected}".`, "info");
					return;
				}

				if (ctx.hasUI) {
					const choice = await ctx.ui.select("Choose error sound:", sounds);
					if (choice) {
						config.errorSound = choice;
						saveConfig(config);
						playSound(choice);
						ctx.ui.notify(`Error sound set to "${choice}".`, "info");
					}
					return;
				}

				ctx.ui.notify(`Available sounds: ${sounds.join(", ")}`, "info");
				return;
			}

			if (subcmd === "min") {
				const sec = parseFloat(parts[1]);
				if (isNaN(sec) || sec < 0) {
					ctx.ui.notify("Usage: /notify min <seconds> (e.g. /notify min 5)", "warning");
					return;
				}
				config.minDurationMs = Math.round(sec * 1000);
				saveConfig(config);
				ctx.ui.notify(
					config.minDurationMs === 0
						? "Minimum duration set to 0s (will notify on all tasks)."
						: `Minimum duration set to ${sec}s (will only notify if task >= ${sec}s).`,
					"info"
				);
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${subcmd}". Run /notify for help.`, "warning");
		},
	});
}
