/**
 * inline-skills — invoke skills anywhere in a prompt with `$skill-name`.
 *
 * - Typing `$` (at line start or after whitespace/opening punctuation) opens a
 *   fuzzy list of skills. Accepting a completion inserts `$skill-name ` IN PLACE
 *   — your sentence is not reordered.
 * - The prompt is stored EXACTLY as typed: `Use $grafana to check p99` shows up
 *   verbatim in the transcript, tree view, editor history, and session file.
 *   No `<skill>` block is ever persisted.
 * - The `context` event expands `$skill-name` mentions into the in-flight
 *   request just before it is sent to the model (in place, on Pi's own clone),
 *   prepending the same `<skill name="..." location="...">` block pi core uses
 *   for /skill:name. Re-applied on every request, so the skill instructions
 *   stay context-resident for the whole conversation.
 * - Tokens inside `inline code` or ``` fenced blocks are ignored, and unknown
 *   names (e.g. $HOME) are left untouched. Messages already expanded by core
 *   `/skill:` (stored with a leading `<skill` block) are skipped.
 *
 * Replaces the npm package `pi-inline-skills-and-prompts`, which moved the
 * skill to the front of the line, and the earlier input-time transform, which
 * polluted the persisted prompt with the skill body.
 */
import { readFileSync, statSync } from "node:fs";
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

/** Skill body cache keyed by path; invalidated when the file's mtime changes. */
const bodyCache = new Map<string, { mtimeMs: number; body: string }>();

function readSkillBody(skill: SkillRef): string {
	const { mtimeMs } = statSync(skill.filePath);
	const cached = bodyCache.get(skill.filePath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.body;
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
	bodyCache.set(skill.filePath, { mtimeMs, body });
	return body;
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

/** Join the text parts of a user message's content. */
function userText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** Prepend the skill block to a user message's first text part (in place). */
function prependToContent(msg: { content: string | Array<{ type: string; text?: string }> }, block: string): void {
	if (typeof msg.content === "string") {
		msg.content = `${block}\n\n${msg.content}`;
		return;
	}
	const idx = msg.content.findIndex((part) => part.type === "text");
	if (idx === -1) {
		msg.content.unshift({ type: "text", text: block });
		return;
	}
	const part = msg.content[idx];
	if (part && typeof part.text === "string") msg.content[idx] = { type: "text", text: `${block}\n\n${part.text}` };
}

export default function (pi: ExtensionAPI): void {
	registerLoadedExtension("inline-skills");

	// ---- Expand $skill mentions in the request sent to the model -----------
	// Runs on every LLM request, on pi's own clone of the conversation. The
	// persisted session (and therefore the transcript, tree view, and editor
	// history) keeps the prompt exactly as typed. Editing event.messages in
	// place is the documented contract and preserves the system message layout,
	// so prompt prefix caching is unaffected.
	pi.on("context", (event) => {
		const skills = getSkills(pi);
		for (const msg of event.messages) {
			if (msg.role !== "user") continue;
			const text = userText(msg.content);
			if (!text.includes("$")) continue;
			// Skip messages already expanded by core /skill: (their body may
			// itself contain $tokens that would spuriously re-expand).
			if (text.startsWith("<skill")) continue;

			const mentions = findSkillMentions(text, skills);
			if (mentions.length === 0) continue;

			let block: string;
			try {
				block = buildSkillBlock(mentions);
			} catch {
				// Fail soft: send the request unexpanded rather than breaking the
				// turn. `context` fires on every request, so surfacing an error here
				// would repeat once per request; an unexpanded $mention is visible
				// in the transcript, which is enough to notice and retry.
				continue;
			}
			prependToContent(msg, block);
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
