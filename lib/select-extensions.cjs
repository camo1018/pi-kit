#!/usr/bin/env node
/**
 * Record which pi-kit resources pi should load, using pi's native
 * object-form package entry (settings.json "packages").
 *
 *   node select-extensions.cjs <settings.json> <package-path> \
 *          [--extensions csv|all] [--skills csv|all|none]
 *
 * Selected names map to real paths via the package's own package.json
 * manifest, so this never needs updating when extensions are added.
 * Omitted keys load everything the package declares; `all` reverts the
 * package entry to a plain string (load everything, no filtering).
 */
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const [settingsPath, pkgPath] = args.splice(0, 2);
if (!settingsPath || !pkgPath || !args.length) {
	console.error("usage: select-extensions.cjs <settings.json> <pkg> [--extensions a,b|all] [--skills a,b|all|none]");
	process.exit(2);
}

const opts = { extensions: undefined, skills: undefined };
for (let i = 0; i < args.length; i += 2) {
	const [flag, val] = [args[i], args[i + 1]];
	if (flag !== "--extensions" && flag !== "--skills") {
		console.error(`select-extensions: unknown flag ${flag}`);
		process.exit(2);
	}
	opts[flag.slice(2)] = val;
}

const settings = path.resolve(settingsPath);
const target = path.resolve(pkgPath);
const manifest = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));

/** Map declared manifest entries ("extensions/foo/index.ts") to names ("foo"). */
function namesFrom(entries) {
	const out = new Map();
	for (const entry of entries ?? []) {
		const parts = entry.split("/");
		if (parts[0] === "extensions" && parts.length === 3) out.set(parts[1], entry);
	}
	return out;
}
const extMap = namesFrom(manifest.pi?.extensions);

/** Skills root "skills" -> every skills/<name>/SKILL.md under it. */
function skillNames() {
	const root = path.join(target, "skills");
	if (!fs.existsSync(root)) return new Map();
	const out = new Map();
	for (const d of fs.readdirSync(root, { withFileTypes: true })) {
		const md = path.join("skills", d.name, "SKILL.md");
		if (d.isDirectory() && fs.existsSync(path.join(root, d.name, "SKILL.md"))) out.set(d.name, md);
	}
	return out;
}

/** CSV of names -> array of manifest paths; 'none' -> [] (load nothing); 'all'/undefined -> undefined (load everything). */
function pick(kind, csv, map) {
	if (csv === undefined || csv === "all") return undefined;
	if (csv === "none") return [];
	const chosen = [];
	for (const raw of csv.split(",").map((s) => s.trim()).filter(Boolean)) {
		const p = map.get(raw);
		if (!p) {
			console.error(`select-extensions: unknown ${kind.slice(0, -1)} '${raw}' (known: ${[...map.keys()].join(", ")})`);
			process.exit(2);
		}
		chosen.push(p);
	}
	return chosen;
}

const extensions = pick("extensions", opts.extensions, extMap);
const skills = pick("skills", opts.skills, skillNames());

const cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
const list = (cfg.packages ??= []);
const base = path.dirname(settings);

const sourceOf = (p) =>
	typeof p === "string"
		? p
		: p && typeof p === "object" && typeof p.source === "string"
			? p.source
			: null;

const resolvesToTarget = (p) => {
	const src = sourceOf(p);
	if (!src || /^(git:|npm:|https?:)/.test(src)) return false;
	try {
		return path.resolve(base, src) === target;
	} catch {
		return false;
	}
};

// Warn when a second pi-kit entry (e.g. an old `pi install git:...`) would
// load the same extensions on top of this one.
for (const p of list) {
	const src = sourceOf(p);
	if (src && !resolvesToTarget(p) && /pi-kit/.test(src))
		console.warn(`⚠ another pi-kit entry is configured (${src}) — run: pi remove ${src}`);
}

const idx = list.findIndex(resolvesToTarget);
const entry = {};
if (extensions !== undefined) entry.extensions = extensions;
if (skills !== undefined) entry.skills = skills;

if (Object.keys(entry).length === 0) {
	// No filtering: revert to a plain string entry (load everything).
	if (idx !== -1 && typeof list[idx] !== "string") list[idx] = sourceOf(list[idx]) ?? pkgPath;
} else if (idx === -1) {
	list.push({ source: pkgPath, ...entry });
} else {
	list[idx] = { source: sourceOf(list[idx]) ?? pkgPath, ...entry };
}

fs.writeFileSync(settings, JSON.stringify(cfg, null, 2) + "\n");

process.stdout.write(
	`  extensions: ${extensions ? extensions.map((e) => path.basename(path.dirname(e))).join(", ") : "all"}\n` +
		(fs.existsSync(path.join(target, "skills"))
			? `  skills: ${skills ? skills.map((s) => path.basename(path.dirname(s))).join(", ") : "all"}\n`
			: ""),
);
