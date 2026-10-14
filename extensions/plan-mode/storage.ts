import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface SavePlanOptions {
	cwd: string;
	planText: string;
	sessionId: string;
	title: string;
	now?: Date;
	rootDir?: string;
}

function slug(value: string, fallback: string, maxLength = 48): string {
	const cleaned = value
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return cleaned || fallback;
}

function timestampForFile(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

function planBody(planText: string): string {
	return planText.replace(/^Plan:\s*/i, "").trim();
}

function markdown(options: SavePlanOptions, createdAt: Date): string {
	const title = options.title.replace(/[\r\n]+/g, " ").trim() || "Plan";
	return [
		`# Plan: ${title}`,
		"",
		`- Created: ${createdAt.toISOString()}`,
		`- Project: \`${resolve(options.cwd)}\``,
		`- Session: \`${options.sessionId}\``,
		"",
		"## Steps",
		"",
		planBody(options.planText),
		"",
	].join("\n");
}

async function writeUnique(
	directory: string,
	stem: string,
	content: string,
): Promise<string> {
	for (let suffix = 1; suffix <= 100; suffix++) {
		const candidate = join(
			directory,
			suffix === 1 ? `${stem}.md` : `${stem}-${suffix}.md`,
		);
		try {
			await writeFile(candidate, content, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Could not allocate a unique plan filename");
}

/**
 * Save a full plan outside the session transcript and return its absolute path.
 */
export async function savePlanFile(options: SavePlanOptions): Promise<string> {
	const createdAt = options.now ?? new Date();
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
	const root = options.rootDir ?? join(agentDir, "plans");
	const project = slug(basename(resolve(options.cwd)), "root");
	const directory = join(root, project);
	const session = slug(options.sessionId.slice(0, 8), "session", 12);
	const title = slug(options.title, "plan");
	const stem = `${timestampForFile(createdAt)}-${title}-${session}`;

	await mkdir(directory, { recursive: true });
	return writeUnique(directory, stem, markdown(options, createdAt));
}
