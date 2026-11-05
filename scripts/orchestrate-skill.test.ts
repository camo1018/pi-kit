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
const SKILL_PATH = join(ROOT, "skills/orchestrate/SKILL.md");

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-orchestrate-skill-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory({
			packages: [
				{
					source: ROOT,
					extensions: [],
					skills: ["skills/orchestrate/SKILL.md"],
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
	const skill = skills.find((skill) => skill.name === "orchestrate");
	assert.ok(skill, "package manifest must expose the orchestrate skill");
	assert.equal(skill.filePath, SKILL_PATH);
	assert.deepEqual(
		diagnostics.filter((diagnostic) => diagnostic.path === SKILL_PATH),
		[],
	);
	return { dir, skill };
}

test("package exposes a valid discoverable orchestrate skill", async (t) => {
	const { skill } = await fixture(t);
	assert.match(skill.description, /planner\/orchestrator split/);
	assert.match(skill.description, /"you plan and delegate"/);
	assert.match(skill.description, /"subagents fetch and synthesize/);
	assert.match(skill.description, /invokes \$orchestrate/);
	assert.match(skill.description, /background parents without takeover/);
	assert.ok(
		skill.description.length <= 1024,
		"description exceeds the 1024 character limit",
	);
	assert.equal(skill.disableModelInvocation, false);
	const prompt = formatSkillsForPrompt([skill]);
	assert.match(prompt, /<name>orchestrate<\/name>/);
	assert.ok(prompt.includes(SKILL_PATH));
	assert.doesNotMatch(prompt, /Run the user's task as an orchestrated fan-out/);
});

test("inline orchestrate expands, not persisted history", async (t) => {
	const { skill } = await fixture(t);
	const handlers = new Map<string, unknown>();
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, handler);
		},
		getCommands() {
			return [
				{
					name: "skill:orchestrate",
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
		"$orchestrate research the retry bug",
		"research the retry bug $orchestrate",
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
		assert.match(text, /^<skill name="orchestrate"/);
		assert.match(text, /parent is the expensive model/);
		assert.match(text, /Start \*\*two workers by default\*\*/);
		assert.match(text, /routine memory maintenance/);
		assert.ok(text.endsWith(content));
		assert.equal(history.messages[0].content, content);
		expand(request);
		assert.equal(request.messages[0].content, text);
	}
});

test("resource selector can enable only the orchestrate skill", async (t) => {
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
		"orchestrate",
	]);
	const selected = JSON.parse(readFileSync(settings, "utf8")).packages[0];
	assert.deepEqual(selected.skills, ["skills/orchestrate/SKILL.md"]);
	assert.deepEqual(selected.extensions, [
		"extensions/inbox/index.ts",
		"extensions/session-workers/index.ts",
	]);
});
