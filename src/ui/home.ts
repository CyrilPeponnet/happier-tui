import { type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isBusy, type Session, sessionTitle } from "../happier/client.js";
import { LOGO_SIZE, renderLogo } from "./logo.js";
import { ago, c, clean, shortPath, SPINNER } from "./theme.js";

const MAX_WIDTH = 96;

/** Sessions that need the user come first, then live ones, then most recently used. */
export function sortSessions(sessions: Session[]): Session[] {
	const rank = (s: Session) =>
		s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0 ? 0 : s.active ? 1 : 2;
	return [...sessions].sort((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt);
}

export function statusGlyph(s: Session, frame: number): string {
	if (s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0) return c.err("!");
	if (isBusy(s)) return c.warn(SPINNER[frame % SPINNER.length] ?? "*");
	if (s.active) return c.ok("●");
	return c.faint("○");
}

export interface HomeHost {
	name: string;
	online: boolean;
}

export interface HomeState {
	/** Sessions to offer, already sorted; inactive ones included only when `showInactive`. */
	sessions: Session[];
	/** Inactive sessions currently left out. */
	hidden: number;
	showInactive: boolean;
	/** Known machines, so hosts without a session are still listed. */
	hosts: HomeHost[];
	hostOf: (s: Session) => string;
	unread: Set<string>;
	currentId: string | null;
	frame: number;
	rows: number;
	status: string;
}

type Entry =
	| { kind: "host"; name: string; online: boolean | null; count: number }
	| { kind: "session"; session: Session }
	| { kind: "action"; key: "new" | "inactive"; label: string; hint: string }
	| { kind: "note"; text: string }
	| { kind: "blank" };

/**
 * Start screen and session switcher: logo, a search box, and the sessions grouped by host.
 * Selection is tracked by key so it stays on the same session while the list updates live.
 */
export class Home implements Component, Focusable {
	onOpen?: (sessionId: string) => void;
	onNew?: () => void;
	onToggleInactive?: () => void;
	/** Escape with nothing to clear: return to the open session, if any. */
	onBack?: () => void;

	private readonly input = new Input({ prompt: c.accent("⌕ "), placeholder: "search sessions, hosts, paths" });
	private selectedKey: string | null = null;
	private _focused = false;
	readonly capturesViewportInput = true;

	constructor(private readonly state: () => HomeState) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	/** Clears the search and puts the selection back on the open session (or the first one). */
	reset(): void {
		this.input.setValue("");
		this.selectedKey = null;
	}

	private entries(st: HomeState): Entry[] {
		const query = this.input.getValue().trim();
		const sessions = query
			? fuzzyFilter(
					st.sessions,
					query,
					(s) => `${sessionTitle(s)} ${st.hostOf(s)} ${s.metadata.flavor ?? ""} ${s.metadata.path ?? ""}`,
				)
			: st.sessions;

		const groups = new Map<string, Session[]>();
		for (const s of sessions) {
			const host = st.hostOf(s);
			const group = groups.get(host);
			if (group) group.push(s);
			else groups.set(host, [s]);
		}
		const online = new Map(st.hosts.map((h) => [h.name, h.online]));
		const out: Entry[] = [];
		for (const [name, group] of groups) {
			out.push({ kind: "host", name, online: online.get(name) ?? null, count: group.length });
			for (const session of group) out.push({ kind: "session", session });
			out.push({ kind: "blank" });
		}
		if (!query) {
			for (const h of st.hosts) {
				if (groups.has(h.name) || !h.online) continue;
				out.push({ kind: "host", name: h.name, online: true, count: 0 });
				out.push({ kind: "note", text: st.showInactive ? "no session" : "no active session" });
				out.push({ kind: "blank" });
			}
		}
		if (sessions.length === 0) {
			out.push({ kind: "note", text: query ? `No session matches "${query}".` : "No active session." });
			out.push({ kind: "blank" });
		}
		out.push({ kind: "action", key: "new", label: "+ New session", hint: "ctrl+n" });
		if (st.showInactive) {
			out.push({ kind: "action", key: "inactive", label: "− Hide inactive sessions", hint: "tab" });
		} else if (st.hidden > 0) {
			const label = `… Show ${st.hidden} inactive session${st.hidden === 1 ? "" : "s"}`;
			out.push({ kind: "action", key: "inactive", label, hint: "tab" });
		}
		return out;
	}

	private static keyOf(e: Entry): string | null {
		return e.kind === "session" ? e.session.id : e.kind === "action" ? `\0${e.key}` : null;
	}

	/**
	 * Index of the selected entry. Until the user moves the selection it follows the list: the
	 * open session if there is one, else the first row — so sessions that load after the screen
	 * appeared are selected ahead of the "new session" action.
	 */
	private selectedIndex(entries: Entry[]): number {
		const keys = entries.map(Home.keyOf);
		const index = this.selectedKey === null ? -1 : keys.indexOf(this.selectedKey);
		if (index >= 0) return index;
		const open = this.state().currentId;
		const preferred = open ? keys.indexOf(open) : -1;
		return preferred >= 0 ? preferred : keys.findIndex((k) => k !== null);
	}

	private move(entries: Entry[], delta: number): void {
		const selectable = entries.map((e, i) => (Home.keyOf(e) === null ? -1 : i)).filter((i) => i >= 0);
		if (selectable.length === 0) return;
		const at = selectable.indexOf(this.selectedIndex(entries));
		const next = selectable[Math.min(selectable.length - 1, Math.max(0, at + delta))];
		const entry = next === undefined ? undefined : entries[next];
		if (entry) this.selectedKey = Home.keyOf(entry);
	}

	handleInput(data: string): void {
		const st = this.state();
		const entries = this.entries(st);
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) return this.move(entries, -1);
		if (matchesKey(data, Key.down)) return this.move(entries, 1);
		if (matchesKey(data, "pageUp")) return this.move(entries, -6);
		if (matchesKey(data, "pageDown")) return this.move(entries, 6);
		if (matchesKey(data, Key.tab)) {
			this.onToggleInactive?.();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const entry = entries[this.selectedIndex(entries)];
			if (entry?.kind === "session") this.onOpen?.(entry.session.id);
			else if (entry?.kind === "action" && entry.key === "new") this.onNew?.();
			else if (entry?.kind === "action") this.onToggleInactive?.();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.input.getValue()) {
				this.input.setValue("");
				this.selectedKey = null;
			} else this.onBack?.();
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		// A new query starts from its best match rather than a row that may have disappeared.
		if (this.input.getValue() !== before) this.selectedKey = null;
	}

	render(width: number): string[] {
		const st = this.state();
		const block = Math.max(20, Math.min(width - 2, MAX_WIDTH));
		const pad = " ".repeat(Math.max(1, Math.floor((width - block) / 2)));
		const entries = this.entries(st);
		const selected = this.selectedIndex(entries);

		const head: string[] = [];
		if (st.rows >= 26 && block >= LOGO_SIZE + 30) {
			// Mark on the left, name and status beside it.
			const beside = new Map<number, string>([
				[3, c.bold("h a p p i e r")],
				[4, c.faint("your agents, from the terminal")],
				[6, st.status],
			]);
			head.push("");
			renderLogo(st.frame).forEach((line, row) => head.push(`${line}   ${beside.get(row) ?? ""}`));
			head.push("");
		} else {
			head.push("", `${c.accent.bold("happier")}  ${st.status}`, "");
		}
		head.push(...this.input.render(block), "");

		const titleWidth = Math.max(12, Math.min(44, Math.floor(block * 0.45)));
		const body: string[] = [];
		let selectedLine = 0;
		entries.forEach((entry, i) => {
			if (i === selected) selectedLine = body.length;
			body.push(this.renderEntry(entry, i === selected, st, block, titleWidth));
		});

		const foot = ["", c.faint("↑↓ select · enter open · type to search · ctrl+n new · tab inactive · esc back · ctrl+c quit")];

		// Keep the selection on screen when the list is taller than the terminal.
		const room = Math.max(3, st.rows - head.length - foot.length);
		let from = 0;
		if (body.length > room) from = Math.min(body.length - room, Math.max(0, selectedLine - Math.floor(room / 2)));
		const shown = body.slice(from, from + room);
		if (from > 0) shown[0] = c.faint("  ↑ more");
		if (from + room < body.length) shown[shown.length - 1] = c.faint("  ↓ more");

		return [...head, ...shown, ...foot].map((line) => truncateToWidth(`${pad}${line}`, width));
	}

	private renderEntry(entry: Entry, selected: boolean, st: HomeState, width: number, titleWidth: number): string {
		switch (entry.kind) {
			case "blank":
				return "";
			case "note":
				return c.faint(`    ${entry.text}`);
			case "host": {
				const dot = entry.online === null ? "" : entry.online ? c.ok(" ● online") : c.faint(" ○ offline");
				const count = entry.count > 0 ? c.faint(`  ${entry.count} session${entry.count === 1 ? "" : "s"}`) : "";
				return `${c.bold(entry.name)}${dot}${count}`;
			}
			case "action": {
				const text = `${selected ? c.accent("› ") : "  "}${selected ? c.accent.bold(entry.label) : entry.label}  ${c.faint(entry.hint)}`;
				return selected ? c.selBg(truncateToWidth(text, width, "…", true)) : text;
			}
			case "session": {
				const s = entry.session;
				const raw = clean(sessionTitle(s)).replace(/\s+/g, " ");
				const unread = st.unread.has(s.id);
				const title = truncateToWidth(raw, titleWidth, "…", true);
				const name = selected ? c.accent.bold(title) : unread ? c.bold(title) : s.active ? title : c.dim(title);
				const open = s.id === st.currentId ? c.accent(" ◂ open") : "";
				const detail = c.faint(
					`${s.metadata.flavor ?? "?"} · ${shortPath(s.metadata.path, s.metadata.homeDir)} · ${ago(s.activityAt)}`,
				);
				const text = `${selected ? c.accent("› ") : "  "}${statusGlyph(s, st.frame)} ${name}  ${detail}${open}`;
				const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
				return selected ? c.selBg(truncateToWidth(fitted, width, "", true)) : fitted;
			}
		}
	}
}
