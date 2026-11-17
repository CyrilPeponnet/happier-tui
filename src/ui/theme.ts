import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";
import chalk from "chalk";

export const c = {
	accent: chalk.hex("#7aa2f7"),
	dim: chalk.gray,
	faint: chalk.hex("#565f89"),
	ok: chalk.hex("#9ece6a"),
	warn: chalk.hex("#e0af68"),
	err: chalk.hex("#f7768e"),
	user: chalk.hex("#bb9af7"),
	tool: chalk.hex("#7dcfff"),
	bold: chalk.bold,
	userBg: chalk.bgHex("#24283b"),
	selBg: chalk.bgHex("#2f3549"),
	headerBg: chalk.bgHex("#1f2335"),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: (t) => c.accent(t),
	selectedText: (t) => c.accent.bold(t),
	description: (t) => c.dim(t),
	scrollInfo: (t) => c.faint(t),
	noMatch: (t) => c.dim(t),
};

export const editorTheme: EditorTheme = {
	borderColor: (s) => c.faint(s),
	selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
	heading: (t) => c.accent.bold(t),
	link: (t) => c.accent.underline(t),
	linkUrl: (t) => c.faint(t),
	code: (t) => chalk.hex("#c0caf5").bgHex("#292e42")(t),
	codeBlock: (t) => c.ok(t),
	codeBlockBorder: (t) => c.faint(t),
	quote: (t) => c.dim.italic(t),
	quoteBorder: (t) => c.faint(t),
	hr: (t) => c.faint(t),
	listBullet: (t) => c.accent(t),
	bold: (t) => chalk.bold(t),
	italic: (t) => chalk.italic(t),
	strikethrough: (t) => chalk.strikethrough(t),
	underline: (t) => chalk.underline(t),
};

/** Remote content is untrusted terminal input: drop escape sequences and control characters. */
export function clean(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
	// Newlines are kept; every other control character is replaced line by line.
	return stripTerminalSequences(normalized)
		.split("\n")
		.map((line) => replaceControlCharacters(line))
		.join("\n");
}

/** Happier agents append reply suggestions as `<options><option>…</option></options>`; show them as a list. */
export function shortPath(path: unknown, home: unknown): string {
	if (typeof path !== "string") return "";
	if (typeof home === "string" && home && (path === home || path.startsWith(`${home}/`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function ago(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.floor((now - ms) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

/** "5m ago", or "just now". */
export function agoText(ms: number, now = Date.now()): string {
	const a = ago(ms, now);
	return a === "now" ? "just now" : `${a} ago`;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
