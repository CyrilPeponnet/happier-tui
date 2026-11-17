// Release notes for a tag, from its commits since the previous tag, grouped by type.
// Commit subjects follow `type: description` or `type/scope: description` (feat, fix, ci, …).
//
//   node scripts/release-notes.mjs v0.2.1    # a given tag
//   node scripts/release-notes.mjs           # the commits since the last tag (a preview)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tryGit = (...args) => {
	try {
		return git(...args);
	} catch {
		return "";
	}
};

const tag = process.argv[2];
const end = tag ?? "HEAD";
// For a tag, the tag before it; for a preview, the latest tag (which HEAD may itself be).
const previous = tryGit("describe", "--tags", "--abbrev=0", tag ? `${tag}^` : "HEAD");
const log = git("log", "--no-merges", "--format=%h%x09%s", previous ? `${previous}..${end}` : end);

const sections = [
	["feat", "New"],
	["fix", "Fixes"],
	["other", "Other changes"],
];
const grouped = new Map(sections.map(([key]) => [key, []]));
for (const line of log.split("\n").filter(Boolean)) {
	const [sha, subject] = line.split("\t");
	if (/^v?\d+\.\d+\.\d+/.test(subject)) continue; // the version bump itself
	const m = /^(\w+)(?:[/(][^:]*)?!?:\s*(.+)$/.exec(subject);
	const type = m && grouped.has(m[1]) ? m[1] : "other";
	const text = m ? m[2] : subject;
	grouped.get(type).push(`- ${text.charAt(0).toUpperCase()}${text.slice(1)} (${sha})`);
}

const repo = JSON.parse(readFileSync("package.json", "utf8"))
	.repository?.url?.replace(/^git\+/, "")
	.replace(/\.git$/, "");
const out = [];
for (const [key, title] of sections) {
	const lines = grouped.get(key);
	if (lines.length) out.push(`## ${title}`, "", ...lines, "");
}
if (out.length === 0) out.push("No changes since the previous release.", "");
out.push("Install or update: `npm install -g happier-tui`");
if (repo && previous) out.push("", `**Full changelog**: ${repo}/compare/${previous}...${end}`);
console.log(out.join("\n"));
