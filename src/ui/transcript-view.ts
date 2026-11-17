import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
	private cache = new Map<string, { sig: string; lines: string[] }>();
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
		for (const row of t.list()) {
			live.add(row.key);
			this.rowStarts.push({ key: row.key, start: out.length });
			const sig = this.signature(row, t, width);
			let entry = this.cache.get(row.key);
			if (!entry || entry.sig !== sig) {
				entry = { sig, lines: this.renderRow(row, t, inner) };
				this.cache.set(row.key, entry);
			}
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
			if (item.kind === "tool") sig += `|t${t.results.has(item.callId) ? 1 : 0}${t.failures.size}`;
			else sig += `|${item.kind[0]}${item.text.length}${"streaming" in item && item.streaming ? "s" : ""}`;
		}
		return sig;
	}

	private renderRow(row: Row, t: Transcript, width: number): string[] {
		const lines: string[] = [];
		for (const item of row.items) {
			const rendered = this.renderItem(item, t, width);
			if (rendered.length === 0) continue;
			lines.push("");
			for (const l of rendered) lines.push(` ${l}`);
		}
		return lines;
	}

	private renderItem(item: Item, t: Transcript, width: number): string[] {
		switch (item.kind) {
			case "user": {
				const body = wrapTextWithAnsi(clean(item.text), Math.max(4, width - 4));
				return body.map((l, i) => {
					const text = `${i === 0 ? c.user.bold("› ") : "  "}${l}`;
					return c.userBg(truncateToWidth(` ${text}`, width, "", true));
				});
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
				if (!isTerminalOutput(item)) return this.renderTool(item, result, width);
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

	private renderTool(item: Extract<Item, { kind: "tool" }>, result: ToolResult | undefined, width: number): string[] {
		const { name, arg } = toolSummary(item);
		const dot = !result ? c.warn("○") : result.isError ? c.err("●") : c.ok("●");
		const head = `${dot} ${c.tool.bold(clean(name))}${arg ? ` ${c.dim(clean(arg))}` : ""}`;
		const lines = [truncateToWidth(head, width)];
		if (!result) return lines;

		const text = clean(toolResultText(result.output)).replace(/\n+$/, "");
		if (!text) return lines;
		const max = this.options.expandTools ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES;
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
			lines.push(c.faint(`    … ${raw.length - shown.length} more lines (ctrl+o to expand)`));
		}
		return lines;
	}
}
