import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { c, selectListTheme } from "./theme.js";

export interface PickerOptions {
	title: string;
	items: SelectItem[];
	hint?: string;
	/** Hide the type-to-filter input (short fixed menus). */
	noFilter?: boolean;
	/** Preselect the item with this value. */
	selected?: string;
	maxVisible?: number;
	onSelect: (item: SelectItem) => void;
	onCancel: () => void;
}

/** Bordered modal: title, optional fuzzy filter, list. Used for every menu in the app. */
export class Picker implements Component, Focusable {
	private readonly input = new Input({ prompt: c.accent("⌕ "), placeholder: "type to filter" });
	private list: SelectList;
	private _focused = false;
	readonly capturesViewportInput = true;

	constructor(private readonly opts: PickerOptions) {
		this.list = this.buildList(opts.items);
		const index = opts.selected ? opts.items.findIndex((i) => i.value === opts.selected) : -1;
		if (index > 0) this.list.setSelectedIndex(index);
	}

	private buildList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, this.opts.maxVisible ?? 12, selectListTheme, { maxPrimaryColumnWidth: 48 });
		list.onSelect = (item) => this.opts.onSelect(item);
		list.onCancel = () => this.opts.onCancel();
		return list;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && !this.opts.noFilter;
	}

	invalidate(): void {
		this.list.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.opts.onCancel();
			return;
		}
		const nav =
			matchesKey(data, Key.up) ||
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown") ||
			matchesKey(data, Key.ctrl("n")) ||
			matchesKey(data, Key.ctrl("p"));
		// In a short fixed menu, a digit picks that item directly.
		const digit = this.opts.noFilter && /^[1-9]$/.test(data) ? this.opts.items[Number(data) - 1] : undefined;
		if (digit) {
			this.opts.onSelect(digit);
			return;
		}
		if (nav || this.opts.noFilter) {
			const mapped = matchesKey(data, Key.ctrl("n")) ? "\x1b[B" : matchesKey(data, Key.ctrl("p")) ? "\x1b[A" : data;
			this.list.handleInput(mapped);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) {
			const query = after.trim();
			const items = query
				? fuzzyFilter(this.opts.items, query, (i) => `${i.label} ${i.description ?? ""}`)
				: this.opts.items;
			this.list = this.buildList(items);
		}
	}

	render(width: number): string[] {
		const inner = Math.max(10, width - 4);
		const body: string[] = [];
		if (!this.opts.noFilter) {
			body.push(...this.input.render(inner), "");
		}
		body.push(...this.list.render(inner));
		if (this.opts.hint) body.push("", c.faint(truncateToWidth(this.opts.hint, inner)));

		const title = truncateToWidth(` ${this.opts.title} `, inner - 1);
		const fill = "─".repeat(Math.max(0, inner + 1 - visibleWidth(title)));
		const lines = [c.faint("╭─") + c.accent.bold(title) + c.faint(`${fill}╮`)];
		for (const line of body) {
			lines.push(`${c.faint("│")} ${truncateToWidth(line, inner, "…", true)} ${c.faint("│")}`);
		}
		lines.push(c.faint(`╰${"─".repeat(inner + 2)}╯`));
		return lines;
	}
}
