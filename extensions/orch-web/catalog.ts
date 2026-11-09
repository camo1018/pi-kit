/**
 * orch-web: what the phone's composer can suggest.
 *
 * The TUI builds `$skill`, `/command` and `@[session]` completions from live
 * pi objects it already has in memory. The daemon is not a pi process, so it
 * has to ask pi's own discovery code instead of duplicating the rules for
 * `settings.json` skill paths, packages, project skills and prompt templates.
 *
 * That discovery runs extension factories (every `pi.registerCommand` lives in
 * one), which is not something to do inside a long-lived daemon: a factory can
 * start timers or claim module-level state. So it runs here, as a short-lived
 * child process, and prints one machine-readable line. The daemon caches the
 * result; see commandCatalog() in server.ts.
 */

import * as path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export const CATALOG_MARKER = "__ORCH_CATALOG__";

export interface CatalogSkill {
	name: string;
	description: string;
	location: string;
}

export interface CatalogPrompt {
	name: string;
	description: string;
	argumentHint?: string;
}

export interface CatalogCommand {
	name: string;
	description: string;
	/**
	 * Meaningful in a background `--mode json` child.
	 *
	 * `skill:name` is expanded by AgentSession before the model call, so it
	 * works anywhere. Every other registered command is an extension command
	 * whose handler runs with `ctx.mode === "json"`; pi-kit's handlers all bail
	 * out unless the mode is "tui", so they are inert in a background run.
	 */
	executesInRun?: boolean;
}

export interface Catalog {
	skills: CatalogSkill[];
	prompts: CatalogPrompt[];
	commands: CatalogCommand[];
	loadedAt: number;
}

/** Build the catalog from pi's own resource discovery. */
export async function buildCatalog(cwd: string): Promise<Catalog> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		// Commands come from extensions; themes and context files cost load time
		// and say nothing about what is typeable.
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const skills = loader.getSkills().skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		location: skill.filePath,
	}));

	const prompts = loader.getPrompts().prompts.map((prompt) => ({
		name: prompt.name,
		description: prompt.description,
		...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
	}));

	// Registered extension commands only. Built-in slash commands (`/model`,
	// `/quit`, `/tree`, …) are interactive-mode features: a background run is
	// `--mode json`, and pi sends `/model` there to the model as plain text.
	const commands: CatalogCommand[] = [];
	for (const extension of loader.getExtensions().extensions) {
		for (const [name, command] of extension.commands) {
			commands.push({
				name,
				description: command.description ?? "",
			});
		}
	}
	// `/skill:name` is the one slash command that works in a background run:
	// AgentSession expands it before the model call, exactly like the TUI. The
	// `$name` form is a pi-kit affordance; this is the portable one.
	for (const skill of skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			executesInRun: true,
		});
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));

	return { skills, prompts, commands, loadedAt: Date.now() };
}

/** Run as a program: print the catalog behind a marker line. */
async function main(): Promise<void> {
	const catalog = await buildCatalog(process.cwd());
	const line = `\n${CATALOG_MARKER}${JSON.stringify(catalog)}\n`;
	// Resolve on the write callback, not on the return value: the payload is
	// larger than a pipe buffer, and the `process.exit` in the caller drops
	// whatever stdout has not flushed yet (which truncated the JSON to an
	// unparseable prefix).
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(line, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/** `import.meta.main` is only in newer Node; compare paths instead. */
function isEntrypoint(): boolean {
	try {
		const entry = process.argv[1];
		if (!entry) return false;
		return import.meta.filename === entry ||
			path.resolve(entry) === path.resolve(import.meta.filename);
	} catch {
		return false;
	}
}

if (isEntrypoint()) {
	main().then(
		() => process.exit(0),
		(error) => {
			process.stderr.write(
				`catalog: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exit(1);
		},
	);
}
