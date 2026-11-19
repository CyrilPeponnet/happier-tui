import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { common, createEmphasize } from "emphasize";

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
	/** Readable but quieter than the agent's text: tool output. */
	soft: chalk.hex("#a9b1d6"),
	userBg: chalk.bgHex("#283a4c"),
	/** Tool panels, by state. */
	toolBg: {
		running: chalk.bgHex("#262a3b"),
		ok: chalk.bgHex("#233328"),
		err: chalk.bgHex("#3a252d"),
	},
	selBg: chalk.bgHex("#2f3549"),
	codeBg: chalk.bgHex("#22252f"),
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

const emphasize = createEmphasize(common);

/** Token colours for code blocks, from the same palette. */
const SYNTAX: Record<string, (s: string) => string> = {
	keyword: chalk.hex("#bb9af7"),
	built_in: chalk.hex("#7dcfff"),
	type: chalk.hex("#2ac3de"),
	literal: chalk.hex("#ff9e64"),
	number: chalk.hex("#ff9e64"),
	string: chalk.hex("#9ece6a"),
	regexp: chalk.hex("#b4f9f8"),
	comment: chalk.hex("#565f89").italic,
	title: chalk.hex("#7aa2f7"),
	attr: chalk.hex("#73daca"),
	attribute: chalk.hex("#73daca"),
	variable: chalk.hex("#c0caf5"),
	meta: chalk.hex("#e0af68"),
	tag: chalk.hex("#f7768e"),
	name: chalk.hex("#f7768e"),
	symbol: chalk.hex("#ff9e64"),
	addition: chalk.hex("#9ece6a"),
	deletion: chalk.hex("#f7768e"),
};

/** Code blocks in a known language are highlighted; others keep the plain code colour. */
function highlightCode(code: string, lang?: string): string[] {
	const name = lang?.trim().split(/\s/)[0]?.toLowerCase();
	if (!name || !emphasize.registered(name)) return code.split("\n").map((l) => markdownTheme.codeBlock(l));
	try {
		return emphasize.highlight(name, code, SYNTAX).value.split("\n");
	} catch {
		return code.split("\n").map((l) => markdownTheme.codeBlock(l));
	}
}

/**
 * Invisible tag on code fences. The view paints every line from one fence to the next, wrapped
 * lines included, which the markdown renderer cannot do as it does not know the screen width.
 */
export const CODE_FENCE = "\x1b_happier:fence\x07";

export const markdownTheme: MarkdownTheme = {
	highlightCode,
	heading: (t) => c.accent.bold(t),
	link: (t) => c.accent.underline(t),
	linkUrl: (t) => c.faint(t),
	code: (t) => chalk.hex("#b4a4f5")(t),
	codeBlock: (t) => c.ok(t),
	// The opening fence shows the language, the closing one is blank: padding inside the block.
	codeBlockBorder: (t) => CODE_FENCE + c.faint(t.replace(/^```/, "  ")),
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
