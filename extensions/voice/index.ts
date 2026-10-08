/**
 * Voice-to-prompt extension for Pi (local, non-streaming).
 *
 * Press the shortcut (default ctrl+shift+v) to start recording, press it again to stop.
 * Audio is recorded with sox (`rec`) as 16 kHz mono WAV, transcribed locally with
 * whisper.cpp (`whisper-cli`, Metal-accelerated), and inserted into the prompt
 * editor for review. Nothing is sent automatically.
 *
 * Requirements:  brew install sox whisper-cpp
 * Models:        ~/.pi/agent/voice/models/ (see DEFAULT_CONFIG)
 * Config:        ~/.pi/agent/voice.json (merged over DEFAULT_CONFIG)
 *
 * Commands:
 *   /voice          toggle recording
 *   /voice cancel   stop recording and discard audio
 *   /voice check    verify binaries, models, and config
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type ChildProcess, spawn } from "node:child_process";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface VoiceConfig {
	/** Toggle shortcut(s). The first one is shown in the status line. */
	shortcut: string | string[];
	/** whisper.cpp ggml model path. */
	model: string;
	/** Silero VAD model path; empty string disables VAD. */
	vadModel: string;
	/** Language code, or "auto". */
	language: string;
	/** Vocabulary / style hint passed as whisper's initial prompt (keep it short). */
	prompt: string;
	threads: number;
	/** Auto-stop and transcribe after this many seconds. */
	maxSeconds: number;
	/** Recordings shorter than this are discarded (avoids hallucinations on accidental taps). */
	minSeconds: number;
	/** Play macOS sounds on start/stop. */
	sounds: boolean;
	startSound: string;
	stopSound: string;
}

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(AGENT_DIR, "voice.json");
const MODELS_DIR = path.join(AGENT_DIR, "voice", "models");

const DEFAULT_CONFIG: VoiceConfig = {
	shortcut: "ctrl+shift+v",
	model: path.join(MODELS_DIR, "ggml-large-v3-turbo-q5_0.bin"),
	vadModel: path.join(MODELS_DIR, "ggml-silero-v5.1.2.bin"),
	language: "en",
	prompt: "",
	threads: Math.min(8, Math.max(4, os.cpus().length - 2)),
	maxSeconds: 300,
	minSeconds: 0.4,
	sounds: true,
	startSound: "Tink",
	stopSound: "Pop",
};

const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const WAV_BYTES_PER_SEC = 16000 * 2; // 16 kHz, mono, 16-bit
const PASTE_COLLAPSE_LIMIT = 1000; // editor collapses larger pastes into a [paste #N] marker

function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadConfig(): VoiceConfig {
	let cfg: VoiceConfig = { ...DEFAULT_CONFIG };
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
		}
	} catch {
		// Malformed config: fall back to defaults; /voice check reports it.
	}
	cfg.model = expandHome(cfg.model);
	cfg.vadModel = cfg.vadModel ? expandHome(cfg.vadModel) : "";
	return cfg;
}

function findBin(name: string): string | undefined {
	const dirs = [...(process.env.PATH ?? "").split(":"), ...BIN_DIRS];
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return undefined;
}

function playSound(enabled: boolean, name: string): void {
	if (!enabled || process.platform !== "darwin") return;
	const file = path.join("/System/Library/Sounds", `${name}.aiff`);
	if (!fs.existsSync(file)) return;
	try {
		spawn("afplay", [file], { stdio: "ignore", detached: true }).unref();
	} catch {
		// ignore
	}
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Strip whisper's non-speech annotations and normalize whitespace. */
function cleanTranscript(raw: string): string {
	return raw
		.replace(/\[[^\]]*\]/g, " ") // [BLANK_AUDIO], [Music], [inaudible]
		.replace(/\((?:silence|music|blank audio|inaudible|applause|laughs?|noise)[^)]*\)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

type State =
	| { kind: "idle" }
	| { kind: "recording"; proc: ChildProcess; file: string; startedAt: number; timer: NodeJS.Timeout; ctx: ExtensionContext; cancelled: boolean }
	| { kind: "transcribing" };

export default function (pi: ExtensionAPI) {
	registerLoadedExtension("voice");
	const config = loadConfig();
	const shortcuts = (Array.isArray(config.shortcut) ? config.shortcut : [config.shortcut]).filter(Boolean);
	const shortcutLabel = shortcuts[0] ?? "/voice";
	let state: State = { kind: "idle" };

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus("voice", text);
		} catch {
			// context may be stale after session replacement
		}
	};

	const notify = (ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") => {
		try {
			ctx.ui.notify(msg, type);
		} catch {
			// ignore
		}
	};

	function insertTranscript(ctx: ExtensionContext, text: string): void {
		const existing = ctx.ui.getEditorText();
		const needsSpace = existing.length > 0 && !/\s$/.test(existing);
		const insert = needsSpace ? ` ${text}` : text;
		if (insert.length <= PASTE_COLLAPSE_LIMIT) {
			// Inserts at the cursor, as a single undoable edit.
			ctx.ui.pasteToEditor(insert);
		} else {
			// Long dictation: append as plain text so it stays editable (no paste marker).
			ctx.ui.setEditorText(existing + insert);
		}
	}

	function startRecording(ctx: ExtensionContext): void {
		const rec = findBin("rec");
		if (!rec) {
			notify(ctx, "voice: `rec` not found. Install with: brew install sox", "error");
			return;
		}
		if (!fs.existsSync(config.model)) {
			notify(ctx, `voice: model not found at ${config.model}`, "error");
			return;
		}

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-"));
		const file = path.join(dir, "input.wav");
		// trim 0 <max> enforces the max duration inside sox itself.
		const proc = spawn(
			rec,
			["-q", "-c", "1", "-r", "16000", "-b", "16", "-e", "signed-integer", file, "trim", "0", String(config.maxSeconds)],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);

		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		const startedAt = Date.now();
		const timer = setInterval(() => {
			setStatus(ctx, `🎙 ${formatElapsed(Date.now() - startedAt)} · ${shortcutLabel} to stop`);
		}, 500);

		const recording: State = { kind: "recording", proc, file, startedAt, timer, ctx, cancelled: false };
		state = recording;
		setStatus(ctx, `🎙 0:00 · ${shortcutLabel} to stop`);
		playSound(config.sounds, config.startSound);

		proc.on("error", (err) => {
			clearInterval(timer);
			state = { kind: "idle" };
			setStatus(ctx, undefined);
			notify(ctx, `voice: failed to start recorder: ${err.message}`, "error");
		});

		// Fires on manual stop (SIGINT) and on hitting maxSeconds.
		proc.on("close", (code, signal) => {
			clearInterval(timer);
			if (state !== recording) return; // already handled (error path)
			if (recording.cancelled) {
				cleanupDir(file);
				state = { kind: "idle" };
				setStatus(ctx, undefined);
				return;
			}
			if (!fs.existsSync(file)) {
				state = { kind: "idle" };
				setStatus(ctx, undefined);
				notify(ctx, `voice: recorder exited (${code ?? signal}): ${stderr.trim().slice(-300) || "no output"}`, "error");
				cleanupDir(file);
				return;
			}
			void transcribe(ctx, file);
		});
	}

	function stopRecording(cancel = false): void {
		if (state.kind !== "recording") return;
		state.cancelled = cancel;
		if (!cancel) playSound(config.sounds, config.stopSound);
		// SIGINT lets sox flush and finalize the WAV header.
		state.proc.kill("SIGINT");
	}

	function cleanupDir(file: string): void {
		try {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		} catch {
			// ignore
		}
	}

	async function transcribe(ctx: ExtensionContext, file: string): Promise<void> {
		state = { kind: "transcribing" };
		const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
		const seconds = Math.max(0, size - 44) / WAV_BYTES_PER_SEC;
		if (seconds < config.minSeconds) {
			cleanupDir(file);
			state = { kind: "idle" };
			setStatus(ctx, undefined);
			notify(ctx, "voice: recording too short, discarded", "warning");
			return;
		}

		const whisper = findBin("whisper-cli");
		if (!whisper) {
			state = { kind: "idle" };
			setStatus(ctx, undefined);
			notify(ctx, "voice: `whisper-cli` not found. Install with: brew install whisper-cpp", "error");
			cleanupDir(file);
			return;
		}

		setStatus(ctx, `⏳ transcribing ${seconds.toFixed(1)}s…`);
		const args = ["-m", config.model, "-f", file, "-l", config.language, "-t", String(config.threads), "-nt", "-np", "-sns"];
		if (config.prompt) args.push("--prompt", config.prompt);
		if (config.vadModel && fs.existsSync(config.vadModel)) args.push("--vad", "--vad-model", config.vadModel);

		const t0 = Date.now();
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const proc = spawn(whisper, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			proc.stdout.on("data", (d) => {
				stdout += d.toString();
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			proc.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
			proc.on("close", (code) => resolve({ code, stdout, stderr }));
		});

		state = { kind: "idle" };
		setStatus(ctx, undefined);

		if (result.code !== 0) {
			notify(ctx, `voice: whisper failed (${result.code}): ${result.stderr.trim().slice(-300)} — audio kept at ${file}`, "error");
			return;
		}
		cleanupDir(file);

		const text = cleanTranscript(result.stdout);
		if (!text) {
			notify(ctx, "voice: no speech detected", "warning");
			return;
		}
		try {
			insertTranscript(ctx, text);
		} catch (err) {
			notify(ctx, `voice: could not insert transcript: ${(err as Error).message}`, "error");
			return;
		}
		notify(ctx, `voice: ${seconds.toFixed(1)}s transcribed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}

	function toggle(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") {
			notify(ctx, "voice: only available in interactive mode", "warning");
			return;
		}
		switch (state.kind) {
			case "idle":
				startRecording(ctx);
				break;
			case "recording":
				stopRecording(false);
				break;
			case "transcribing":
				notify(ctx, "voice: still transcribing…", "warning");
				break;
		}
	}

	function check(ctx: ExtensionContext): void {
		const lines: string[] = [];
		let configOk = true;
		if (fs.existsSync(CONFIG_PATH)) {
			try {
				JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			} catch {
				configOk = false;
			}
		}
		const rec = findBin("rec");
		const whisper = findBin("whisper-cli");
		lines.push(`rec (sox):    ${rec ?? "MISSING — brew install sox"}`);
		lines.push(`whisper-cli:  ${whisper ?? "MISSING — brew install whisper-cpp"}`);
		lines.push(`model:        ${fs.existsSync(config.model) ? "ok" : "MISSING"} ${config.model}`);
		lines.push(`vad model:    ${config.vadModel ? (fs.existsSync(config.vadModel) ? "ok" : "MISSING") : "disabled"} ${config.vadModel}`);
		lines.push(`config:       ${fs.existsSync(CONFIG_PATH) ? (configOk ? "ok" : "INVALID JSON (using defaults)") : "defaults"} ${CONFIG_PATH}`);
		lines.push(`shortcut:     ${shortcuts.join(", ")}  ·  language: ${config.language}  ·  threads: ${config.threads}`);
		const ok = rec && whisper && fs.existsSync(config.model) && configOk;
		notify(ctx, lines.join("\n"), ok ? "info" : "warning");
	}

	for (const key of shortcuts) {
		pi.registerShortcut(key as KeyId, {
			description: "Voice: start/stop dictation into the prompt",
			handler: (ctx) => toggle(ctx),
		});
	}

	pi.registerCommand("voice", {
		description: "Voice dictation: /voice [cancel|check]",
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase() ?? "";
			if (sub === "cancel") {
				if (state.kind === "recording") {
					stopRecording(true);
					notify(ctx, "voice: recording discarded");
				} else {
					notify(ctx, "voice: not recording", "warning");
				}
				return;
			}
			if (sub === "check") {
				check(ctx);
				return;
			}
			toggle(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		if (state.kind === "recording") {
			clearInterval(state.timer);
			state.cancelled = true;
			try {
				state.proc.kill("SIGKILL");
			} catch {
				// ignore
			}
			cleanupDir(state.file);
		}
		state = { kind: "idle" };
	});
}
