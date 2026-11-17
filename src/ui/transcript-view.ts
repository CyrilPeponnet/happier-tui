import {
	type Component,
	Markdown,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	isTerminalOutput,
	type Item,
	type Row,
	type ToolResult,
	type Transcript,
	toolResultText,
	toolSummary,
} from "../happier/transcript.js";
import { c, clean, markdownTheme, renderOptionsMarkup } from "./theme.js";

const COLLAPSED_RESULT_LINES = 4;
const EXPANDED_RESULT_LINES = 400;
const COLLAPSED_THINKING_LINES = 2;
const MORE_HINT = "more lines (click, or ctrl+o for all)";

/** Tools that run a subagent, whose own transcript is shown under the call. */
const SUBAGENT_TOOLS = /^(task|agent|subagent)$/i;

type Tool = Extract<Item, { kind: "tool" }>;

/** How one row is shown given its neighbours: folded tool runs and a turn summary after it. */
interface RowLayout {
	/** First tool of a folded run → the tools in that run. */
	runs: Map<string, Tool[]>;
	/** First tool of a run unfolded by a click → the size of the run, to fold it back. */
	opened: Map<string, number>;
	/** Tools folded into a run shown elsewhere. */
	hidden: Set<string>;
	/** Closing line of a finished turn, shown after this row. */
	summary?: string;
}

const NO_LAYOUT: RowLayout = { runs: new Map(), opened: new Map(), hidden: new Set() };

/** A rendered row, and which of its lines react to a click. */
interface RenderedRow {
	lines: string[];
	clicks: Array<[offset: number, key: string]>;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export interface ViewOptions {
	expandTools: boolean;
	showThinking: boolean;
}

/**
 * Renders a Transcript as terminal lines. Each row is cached on a signature of what
 * can change it, so a streaming update re-renders one row rather than the whole chat.
 */
export class TranscriptView implements Component {
	transcript: Transcript | null = null;
	/** Shown instead of content (loading / empty / error states). */
	placeholder = "";
	hasEarlier = false;
	loadingEarlier = false;
	readonly options: ViewOptions = { expandTools: false, showThinking: true };
	lastWidth = 80;
	/** Whether the agent is still working on the last turn (which then stays unfolded). */
	isBusy: () => boolean = () => false;
	/** Asked once per subagent call whose transcript is not loaded yet. */
	onSubagent?: (callId: string) => void;
	private cache = new Map<string, { sig: string } & RenderedRow>();
	/** Folded runs the user opened, and tools whose whole output they asked for, by call id. */
	private readonly opened = new Set<string>();
	private readonly full = new Set<string>();
	private toggles = 0;
	/** Clickable lines of the last render: line → what a click toggles. */
	private clickable = new Map<number, string>();
	/** Called before a click changes the layout, e.g. to keep the viewport still. */
	onToggle?: () => void;
	/** First line of each row in the last render, for keeping the viewport anchored across re-layouts. */
	private rowStarts: Array<{ key: string; start: number }> = [];

	/** The row occupying `line` in the last render, and how far into that row the line is. */
	anchorAt(line: number): { key: string; offset: number } | null {
		let found: { key: string; start: number } | null = null;
		for (const r of this.rowStarts) {
			if (r.start > line) break;
			found = r;
		}
		return found ? { key: found.key, offset: line - found.start } : null;
	}

	/** Line where a row starts in the last render. */
	lineOf(key: string): number | null {
		return this.rowStarts.find((r) => r.key === key)?.start ?? null;
	}

	invalidate(): void {
		this.cache.clear();
	}

	setTranscript(t: Transcript | null): void {
		this.transcript = t;
		this.cache.clear();
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const t = this.transcript;
		const inner = Math.max(10, width - 2);
		if (!t || t.list().length === 0) {
			return ["", ...wrapTextWithAnsi(c.dim(this.placeholder || "No messages yet."), inner).map((l) => ` ${l}`)];
		}
		const out: string[] = [];
		if (this.hasEarlier) {
			out.push(c.faint(truncateToWidth(this.loadingEarlier ? " ↑ loading earlier messages…" : " ↑ scroll to top for earlier messages", width)));
		}
		const live = new Set<string>();
		this.rowStarts = [];
		const layouts = this.layout(t);
		const clickable = new Map<number, string>();
		this.clickable = clickable;
		for (const row of t.list()) {
			live.add(row.key);
			this.rowStarts.push({ key: row.key, start: out.length });
			const layout = layouts.get(row.key) ?? NO_LAYOUT;
			const sig = `${this.signature(row, t, width)}|${this.toggles}|${[...layout.runs.keys()].join()}|${layout.hidden.size}|${layout.summary ?? ""}`;
			let entry = this.cache.get(row.key);
			if (!entry || entry.sig !== sig) {
				entry = { sig, ...this.renderRow(row, t, inner, layout) };
				this.cache.set(row.key, entry);
			}
			for (const [offset, key] of entry.clicks) clickable.set(out.length + offset, key);
			for (const line of entry.lines) out.push(line);
		}
		if (this.cache.size > live.size) {
			for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
		}
		out.push("");
		return out;
	}

	private signature(row: Row, t: Transcript, width: number): string {
		let sig = `${width}|${this.options.expandTools ? 1 : 0}${this.options.showThinking ? 1 : 0}|${row.seq ?? "live"}`;
		for (const item of row.items) {
			if (item.kind === "tool") {
				sig += `|t${t.results.has(item.callId) ? 1 : 0}${t.failures.size}${t.sidechains.get(item.callId)?.version ?? ""}`;
			}
			else sig += `|${item.kind[0]}${item.text.length}${"streaming" in item && item.streaming ? "s" : ""}`;
		}
		return sig;
	}

	/**
	 * Splits the transcript into turns (a user message and what followed it). In a finished turn,
	 * consecutive tool calls fold into one line, unless tool output is expanded; every finished
	 * turn ends with a summary line.
	 */
	private layout(t: Transcript): Map<string, RowLayout> {
		const rows = t.list();
		const out = new Map<string, RowLayout>();
		const starts = rows.flatMap((r, i) => (r.items[0]?.kind === "user" ? [i] : []));
		if (starts[0] !== 0) starts.unshift(0);
		starts.forEach((from, n) => {
			const to = n + 1 < starts.length ? starts[n + 1]! : rows.length;
			const last = n + 1 === starts.length;
			if (last && this.isBusy()) return;
			const turn = rows.slice(from, to);
			const layout = (r: Row) =>
				out.get(r.key) ?? out.set(r.key, { runs: new Map(), opened: new Map(), hidden: new Set() }).get(r.key)!;

			let tools = 0;
			let run: Array<{ row: Row; tool: Tool }> = [];
			const close = () => {
				const first = run[0];
				if (first && !this.options.expandTools) {
					if (this.opened.has(first.tool.callId)) layout(first.row).opened.set(first.tool.callId, run.length);
					else {
						layout(first.row).runs.set(first.tool.callId, run.map((r) => r.tool));
						for (const r of run.slice(1)) layout(r.row).hidden.add(r.tool.callId);
					}
				}
				run = [];
			};
			for (const row of turn) {
				for (const item of row.items) {
					if (item.kind === "tool" && !isTerminalOutput(item)) {
						tools++;
						run.push({ row, tool: item });
					} else if (item.kind !== "thinking" || this.options.showThinking) close();
				}
			}
			close();

			const user = turn[0]?.items[0]?.kind === "user" ? turn[0] : undefined;
			const end = turn.at(-1);
			if (!user || !end || end === user) return;
			const failed = turn.some((r) => r.items.some((i) => i.kind === "notice" && i.level === "error"));
			const parts = [formatDuration(end.createdAt - user.createdAt), ...(tools ? [`${tools} tool${tools === 1 ? "" : "s"}`] : [])];
			layout(end).summary = `${failed ? c.err("✗") : c.ok("✓")} ${c.faint(parts.join(" · "))}`;
		});
		return out;
	}

	private renderRow(row: Row, t: Transcript, width: number, layout: RowLayout): RenderedRow {
		const lines: string[] = [];
		const clicks: RenderedRow["clicks"] = [];
		for (const item of row.items) {
			if (item.kind === "tool" && layout.hidden.has(item.callId)) continue;
			const run = item.kind === "tool" ? layout.runs.get(item.callId) : undefined;
			const rendered = run ? [this.renderRun(run, t, width)] : this.renderItem(item, t, width);
			if (rendered.length === 0) continue;
			lines.push("");
			const opened = item.kind === "tool" ? layout.opened.get(item.callId) : undefined;
			if (item.kind === "tool" && opened !== undefined) {
				clicks.push([lines.length, `run:${item.callId}`]);
				lines.push(` ${c.faint(`▾ ${opened} tool${opened === 1 ? "" : "s"}`)}`);
			}
			if (item.kind === "tool" && !isTerminalOutput(item)) {
				const key = `${run ? "run" : "tool"}:${item.callId}`;
				clicks.push([lines.length, key]);
				// "… N more lines" opens the output too, as it says.
				if (rendered.at(-1)?.includes(MORE_HINT)) {
					clicks.push([lines.length + rendered.length - 1, key]);
				}
			}
			for (const l of rendered) lines.push(` ${l}`);
		}
		if (layout.summary) lines.push("", ` ${layout.summary}`);
		return { lines, clicks };
	}

	/**
	 * A click on a folded run unfolds it (and on its "▾" line folds it back); a click on a tool
	 * shows or trims its whole output. Other clicks are left to text selection.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const key = event.button === "left" ? this.clickable.get(event.y) : undefined;
		if (!key) return undefined;
		if (event.type !== "click") return { handled: true, render: false };
		this.onToggle?.();
		const id = key.slice(key.indexOf(":") + 1);
		const set = key.startsWith("run:") ? this.opened : this.full;
		if (!set.delete(id)) set.add(id);
		this.toggles++;
		return { handled: true, render: true };
	}

	/** Tool calls of a finished turn, as one line: `▸ ● Bash Run the tests` or `▸ 4 tools · Bash ×3 · Read`. */
	private renderRun(tools: Tool[], t: Transcript, width: number): string {
		const failed = tools.filter((i) => t.results.get(i.callId)?.isError).length;
		const fail = failed ? c.err(` · ${failed} failed`) : "";
		if (tools.length === 1) {
			const { name, arg } = toolSummary(tools[0]!);
			const dot = failed ? c.err("●") : c.ok("●");
			return truncateToWidth(`${c.faint("▸")} ${dot} ${c.tool(clean(name))}${arg ? ` ${c.dim(clean(arg))}` : ""}`, width);
		}
		const counts = new Map<string, number>();
		for (const i of tools) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
		const names = [...counts].map(([n, k]) => (k > 1 ? `${clean(n)} ×${k}` : clean(n))).join(" · ");
		return truncateToWidth(`${c.faint("▸")} ${c.dim(`${tools.length} tools · ${names}`)}${fail}`, width);
	}

	private renderItem(item: Item, t: Transcript, width: number): string[] {
		switch (item.kind) {
			case "user": {
				const body = wrapTextWithAnsi(clean(item.text), Math.max(4, width - 4));
				return body.map((l) => c.userBg(truncateToWidth(`${c.accent("▌")} ${c.user(l)}`, width, "", true)));
			}
			case "text": {
				const md = new Markdown(renderOptionsMarkup(clean(item.text)), 0, 0, markdownTheme);
				const lines = md.render(width);
				if (item.streaming && lines.length) lines[lines.length - 1] += c.accent(" ▍");
				return lines.map((l) => truncateToWidth(l, width));
			}
			case "thinking": {
				if (!this.options.showThinking) return [];
				const all = wrapTextWithAnsi(clean(item.text).trim(), Math.max(4, width - 2));
				const shown = this.options.expandTools || item.streaming ? all : all.slice(0, COLLAPSED_THINKING_LINES);
				const tail = item.streaming ? all.slice(-6) : shown;
				const lines = tail.map((l, i) => c.faint.italic(`${i === 0 ? "∴ " : "  "}${l}`));
				if (!item.streaming && all.length > shown.length) {
					lines.push(c.faint(`  … ${all.length - shown.length} more lines`));
				}
				return lines;
			}
			case "tool": {
				const result = t.results.get(item.callId);
				if (!isTerminalOutput(item)) return this.renderTool(item, result, t, width);
				const text = result ? clean(toolResultText(result.output)).trim() : "";
				// The same text follows as a "Turn failed" notice; do not show it twice.
				if (!text || t.failures.has(text)) return [];
				const color = result?.isError ? c.err : c.dim;
				const max = this.options.expandTools ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES * 2;
				return text
					.split("\n")
					.slice(0, max)
					.flatMap((l) => wrapTextWithAnsi(l, Math.max(4, width - 2)))
					.map((l) => color(`· ${l}`));
			}
			case "notice": {
				const color = item.level === "error" ? c.err : item.level === "warn" ? c.warn : c.dim;
				return wrapTextWithAnsi(clean(item.text), Math.max(4, width - 4)).map((l) => color(`· ${l}`));
			}
		}
	}

	/** A subagent's progress: a one-line summary, or with ctrl+o every step it took. */
	private renderSubagent(callId: string, t: Transcript, width: number): string[] {
		const sub = t.sidechains.get(callId);
		if (!sub) {
			this.onSubagent?.(callId);
			return [];
		}
		const items = sub.list().flatMap((r) => r.items);
		const tools = items.filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool");
		if (items.length === 0) return [];
		const step = (i: Extract<Item, { kind: "tool" }>) => {
			const { name, arg } = toolSummary(i);
			const r = sub.results.get(i.callId);
			const dot = !r ? c.warn("○") : r.isError ? c.err("●") : c.ok("●");
			return `${dot} ${clean(name)}${arg ? ` ${c.dim(clean(arg))}` : ""}`;
		};
		if (!this.options.expandTools) {
			const last = tools.at(-1);
			const count = `${tools.length} step${tools.length === 1 ? "" : "s"}`;
			return [truncateToWidth(`${c.faint("  ↳ ")}${c.dim(`subagent · ${count}`)}${last ? `${c.faint(" · ")}${step(last)}` : ""}`, width)];
		}
		const bar = c.faint("  │ ");
		const inner = Math.max(4, width - 4);
		const out: string[] = [];
		// The subagent's last words come back as the tool result, shown right below.
		const result = t.results.get(callId);
		const final = result ? clean(toolResultText(result.output)).trim() : "";
		for (const i of items) {
			if (i.kind === "text" && final && clean(i.text).trim() === final) continue;
			if (i.kind === "tool") out.push(truncateToWidth(`${bar}${step(i)}`, width));
			else if (i.kind === "text" || i.kind === "user") {
				for (const l of wrapTextWithAnsi(clean(i.text).trim(), inner).slice(0, 12)) out.push(`${bar}${c.dim(l)}`);
			}
		}
		return out;
	}

	private renderTool(item: Extract<Item, { kind: "tool" }>, result: ToolResult | undefined, t: Transcript, width: number): string[] {
		const { name, arg, detail } = toolSummary(item);
		const dot = !result ? c.warn("○") : result.isError ? c.err("●") : c.ok("●");
		const head = `${dot} ${c.tool.bold(clean(name))}${arg ? ` ${c.dim(clean(arg))}` : ""}`;
		const lines = [truncateToWidth(head, width)];
		if (detail && this.options.expandTools) {
			for (const l of wrapTextWithAnsi(clean(detail), Math.max(4, width - 4)).slice(0, 6)) lines.push(c.faint(`  ${l}`));
		}
		if (SUBAGENT_TOOLS.test(item.name) || t.sidechains.has(item.callId)) lines.push(...this.renderSubagent(item.callId, t, width));
		if (!result) return lines;

		const text = clean(toolResultText(result.output)).replace(/\n+$/, "");
		if (!text) return lines;
		const max = this.options.expandTools || this.full.has(item.callId) ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES;
		const raw = text.split("\n");
		const bodyWidth = Math.max(4, width - 4);
		const shown = raw.slice(0, max);
		shown.forEach((line, i) => {
			const color = result.isError
				? c.err
				: line.startsWith("@@")
					? c.accent
					: /^\+(?!\+\+)/.test(line)
					? c.ok
					: /^-(?!--)/.test(line)
						? c.err
						: c.dim;
			lines.push(`${c.faint(i === 0 ? "  ⎿ " : "    ")}${color(truncateToWidth(line, bodyWidth))}`);
		});
		if (raw.length > shown.length) {
			lines.push(c.faint(`    … ${raw.length - shown.length} ${MORE_HINT}`));
		}
		return lines;
	}
}
