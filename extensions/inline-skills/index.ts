/**
 * inline-skills — invoke skills anywhere in a prompt with `$skill-name`.
 *
 * - Typing `$` (at line start or after whitespace/opening punctuation) opens a
 *   fuzzy list of skills. Accepting a completion inserts `$skill-name ` IN PLACE
 *   — your sentence is not reordered.
 * - On submit, every `$skill-name` token that matches a loaded skill is expanded:
 *   the skill instructions are prepended as a <skill> block (same format pi core
 *   uses for /skill:name, so it renders collapsed in the TUI), and your message
 *   text is kept verbatim after it.
 * - Tokens inside `inline code` or ``` fenced blocks are ignored, and unknown
 *   names (e.g. $HOME) are left untouched.
 *
 * Replaces the npm package `pi-inline-skills-and-prompts`, which moved the
 * skill to the front of the line.
 */
import { readFileSync } from "node:fs";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

// `$query` immediately before the cursor, preceded by start/whitespace/opening punctuation.
const COMPLETION_PATTERN = /(?:^|[\s([{<"'`])\$([\w.:-]*)$/;
// `$name` tokens in submitted text.
const TOKEN_PATTERN = /(^|[\s([{<"'])\$([A-Za-z0-9][\w.-]*)/g;

interface SkillRef {
	name: string;
	filePath: string;
	baseDir: string;
	description?: string;
}

function getSkills(pi: ExtensionAPI): Map<string, SkillRef> {
	const map = new Map<string, SkillRef>();
	for (const cmd of pi.getCommands() as SlashCommandInfo[]) {
		if (cmd.source !== "skill") continue;
		const name = cmd.name.replace(/^skill:/, "");
		const filePath = cmd.sourceInfo.path;
		const baseDir = cmd.sourceInfo.baseDir ?? filePath.replace(/\/[^/]*$/, "");
		map.set(name, { name, filePath, baseDir, description: cmd.description });
	}
	return map;
}

/** Return [start, end) ranges covered by fenced or inline code. */
function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
	return ranges;
}

function findSkillMentions(text: string, skills: Map<string, SkillRef>): SkillRef[] {
	const code = codeRanges(text);
	const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
	const found = new Map<string, SkillRef>();
	for (const m of text.matchAll(TOKEN_PATTERN)) {
		const dollarIdx = (m.index ?? 0) + m[1].length;
		if (inCode(dollarIdx)) continue;
		// Allow trailing sentence punctuation: "$grafana." / "$grafana,"
		let name = m[2];
		while (name && !skills.has(name) && /[.\-]$/.test(name)) name = name.slice(0, -1);
		const skill = skills.get(name);
		if (skill && !found.has(skill.name)) found.set(skill.name, skill);
	}
	return [...found.values()];
}

function readSkillBody(skill: SkillRef): string {
	return stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
}

function buildSkillBlock(skills: SkillRef[]): string {
	if (skills.length === 1) {
		const s = skills[0];
		return `<skill name="${s.name}" location="${s.filePath}">\nReferences are relative to ${s.baseDir}.\n\n${readSkillBody(s)}\n</skill>`;
	}
	// Multiple skills: one outer <skill> block (so the TUI still collapses it),
	// with each skill in its own inner section.
	const names = skills.map((s) => s.name).join(", ");
	const inner = skills
		.map(
			(s) =>
				`<skill-instructions name="${s.name}" location="${s.filePath}">\nReferences are relative to ${s.baseDir}.\n\n${readSkillBody(s)}\n</skill-instructions>`,
		)
		.join("\n\n");
	return `<skill name="${names}" location="${skills[0].filePath}">\nThe user referenced multiple skills inline. Apply each where referenced.\n\n${inner}\n</skill>`;
}

export default function (pi: ExtensionAPI): void {
	registerLoadedExtension("inline-skills");
	// ---- Expand $skill mentions on submit ---------------------------------
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text;
		if (!text.includes("$")) return { action: "continue" };
		// Leave real slash commands alone (core handles /skill:x and prompt templates).
		if (text.startsWith("/")) return { action: "continue" };

		const mentions = findSkillMentions(text, getSkills(pi));
		if (mentions.length === 0) return { action: "continue" };

		try {
			const block = buildSkillBlock(mentions);
			return { action: "transform", text: `${block}\n\n${text}` };
		} catch (err) {
			ctx.ui.notify(`inline-skills: failed to load skill: ${err instanceof Error ? err.message : String(err)}`, "error");
			return { action: "continue" };
		}
	});

	// ---- `$` autocomplete that inserts in place ---------------------------
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["$"],

			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const query = match[1] ?? "";
				const skills = [...getSkills(pi).values()];
				const matches = query
					? fuzzyFilter(skills, query, (s) => `${s.name} ${s.description ?? ""}`)
					: skills;
				if (matches.length === 0) return null;

				return {
					prefix: `$${query}`,
					items: matches.map((s) => ({
						value: `$${s.name}`,
						label: s.name,
						description: s.description,
					})),
				};
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match || !item.value.startsWith("$")) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}

				const tokenStart = cursorCol - (match[1].length + 1);
				const after = line.slice(cursorCol);
				const insert = after.startsWith(" ") ? item.value : `${item.value} `;
				const newLines = [...lines];
				newLines[cursorLine] = line.slice(0, tokenStart) + insert + after;
				return { lines: newLines, cursorLine, cursorCol: tokenStart + insert.length };
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
