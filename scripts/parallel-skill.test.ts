import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	SettingsManager,
	formatSkillsForPrompt,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import inlineSkills from "../extensions/inline-skills/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_PATH = join(ROOT, "skills/parallel/SKILL.md");

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-parallel-skill-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory({
			packages: [
				{
					source: ROOT,
					extensions: [],
					skills: ["skills/parallel/SKILL.md"],
				},
			],
		}),
		noExtensions: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	const skill = skills.find((skill) => skill.name === "parallel");
	assert.ok(skill, "package manifest must expose the parallel skill");
	assert.equal(skill.filePath, SKILL_PATH);
	assert.deepEqual(
		diagnostics.filter((diagnostic) => diagnostic.path === SKILL_PATH),
		[],
	);
	return { dir, skill };
}

test("package exposes a valid discoverable parallel skill", async (t) => {
	const { skill } = await fixture(t);
	assert.match(skill.description, /background parents without takeover/);
	assert.equal(skill.disableModelInvocation, false);
	const prompt = formatSkillsForPrompt([skill]);
	assert.match(prompt, /<name>parallel<\/name>/);
	assert.ok(prompt.includes(SKILL_PATH));
	assert.doesNotMatch(prompt, /Run the user's task through/);
});

test("inline parallel shorthand expands in headless context, not history", async (t) => {
	const { skill } = await fixture(t);
	const handlers = new Map<string, unknown>();
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, handler);
		},
		getCommands() {
			return [
				{
					name: "skill:parallel",
					source: "skill",
					description: skill.description,
					sourceInfo: skill.sourceInfo,
				},
			];
		},
	} as unknown as ExtensionAPI;
	inlineSkills(pi);
	type Request = {
		messages: { role: "user"; content: string; timestamp: number }[];
	};
	const expand = handlers.get("context") as (event: Request) => void;
	for (const content of [
		"$parallel fix the retry bug",
		"fix the retry bug $parallel",
	]) {
		const history: Request = {
			messages: [
				{
					role: "user",
					content,
					timestamp: 1,
				},
			],
		};
		const request = structuredClone(history);
		expand(request);
		const text = request.messages[0].content;
		assert.match(text, /^<skill name="parallel"/);
		assert.match(text, /Do not require takeover/);
		assert.match(text, /Start \*\*two workers\*\*/);
		assert.match(text, /routine memory maintenance/);
		assert.ok(text.endsWith(content));
		assert.equal(history.messages[0].content, content);
		expand(request);
		assert.equal(request.messages[0].content, text);
	}
});

test("resource selector can enable only the parallel skill", async (t) => {
	const { dir } = await fixture(t);
	const settings = join(dir, "settings.json");
	writeFileSync(
		settings,
		JSON.stringify({
			packages: [
				{
					source: ROOT,
					extensions: ["extensions/inbox/index.ts"],
				},
			],
		}),
	);
	execFileSync(process.execPath, [
		join(ROOT, "lib/select-extensions.cjs"),
		settings,
		ROOT,
		"--extensions",
		"inbox,session-workers",
		"--skills",
		"parallel",
	]);
	const selected = JSON.parse(readFileSync(settings, "utf8")).packages[0];
	assert.deepEqual(selected.skills, ["skills/parallel/SKILL.md"]);
	assert.deepEqual(selected.extensions, [
		"extensions/inbox/index.ts",
		"extensions/session-workers/index.ts",
	]);
});
