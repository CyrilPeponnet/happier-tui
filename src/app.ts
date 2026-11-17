import { appendFileSync } from "node:fs";
import {
	type Component,
	Editor,
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	ScrollView,
	type SlashCommand,
	truncateToWidth,
	TuiAltScreen,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type HappierClient,
	HappierError,
	isBusy,
	type MessageRow,
	type PermissionRequest,
	pendingRequests,
	type Session,
	sessionModels,
	sessionTitle,
} from "./happier/client.js";
import { Transcript } from "./happier/transcript.js";
import {
	type AttentionState,
	attentionChange,
	FOCUS_IN,
	FOCUS_OUT,
	type NotifyOptions,
	notificationSequence,
} from "./ui/notify.js";
import { type LocalLaunch, NewSessionFlow } from "./new-session.js";
import { errorText, justify, machineName, questionsOf, requestSummary, shortHost } from "./ui/format.js";
import { SessionAutocomplete } from "./ui/autocomplete.js";
import { Picker, type PickerOptions } from "./ui/picker.js";
import { Home, sortSessions, statusGlyph } from "./ui/home.js";
import { c, clean, editorTheme, shortPath, SPINNER } from "./ui/theme.js";
import { TranscriptView } from "./ui/transcript-view.js";

const PERMISSION_MODES = ["default", "read-only", "safe-yolo", "yolo", "plan"];
/** Without input for this long the user counts as away, even if the terminal still has focus. */
const PRESENCE_IDLE_MS = 3 * 60_000;

const LOCAL_COMMANDS: SlashCommand[] = [
	{ name: "sessions", description: "Back to the session list (ctrl+s)" },
	{ name: "new-session", description: "Start a new agent session on a machine (ctrl+n)" },
	{ name: "mode", description: "Change the permission mode" },
	{ name: "model", description: "Change the model" },
	{ name: "abort", description: "Interrupt the current turn (esc)" },
	{ name: "stop-session", description: "Stop the session's agent process" },
	{ name: "archive", description: "Archive this session" },
	{ name: "reload", description: "Reload sessions and this transcript" },
	{ name: "keys", description: "Show key bindings" },
	{ name: "quit", description: "Exit" },
];

const KEYS_HELP = [
	"enter send · shift+enter newline · esc interrupt the agent",
	"ctrl+s session list · ctrl+n new session · alt+↑/↓ previous/next active session",
	"ctrl+r answer a permission request · ctrl+o expand tool output · ctrl+t toggle thinking",
	"pgup/pgdn scroll · ctrl+shift+f search · ctrl+c twice to quit",
].join("\n");

/** Appends a line to $HAPPIER_TUI_DEBUG, for diagnosing focus / notification decisions. */
function debug(message: string): void {
	const file = process.env.HAPPIER_TUI_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// diagnostics must never break the UI
	}
}

class Lines implements Component {
	constructor(private readonly fn: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.fn(width).map((l) => truncateToWidth(l, width));
	}
}

interface Entry {
	transcript: Transcript;
	loaded: boolean;
	hasEarlier: boolean;
	nextBeforeSeq: number | null;
	loadingEarlier: boolean;
}

export class App {
	private readonly tui: TuiAltScreen;
	private readonly view = new TranscriptView();
	private readonly scroll: ScrollView;
	private readonly editor: Editor;
	private readonly home: Home;
	private readonly chatRoot: VStack;
	private readonly homeRoot: VStack;
	/** "home" is the start screen / session switcher, "chat" an open session. */
	private mode: "home" | "chat" = "home";
	private readonly entries = new Map<string, Entry>();
	private readonly unread = new Set<string>();
	/** Sessions we sent a prompt to and have not heard back from yet. */
	private readonly awaiting = new Map<string, number>();
	private readonly prompted = new Set<string>();
	/** Last observed attention-relevant state per session, to notify on changes only. */
	private readonly attention = new Map<string, AttentionState>();
	/** Whether this terminal has focus. Only meaningful once `focusKnown` is set. */
	private focused = true;
	/** The terminal has reported focus at least once, i.e. it supports focus reporting. */
	private focusKnown = false;
	private lastInputAt = Date.now();
	private readonly newSessionFlow: NewSessionFlow;
	private currentId: string | null = null;
	private showInactive = false;
	private loaded = false;
	private loadError = "";
	private frame = 0;
	private notice: { text: string; level: "info" | "warn" | "error"; until: number } | null = null;
	private overlay: OverlayHandle | null = null;
	private lastCtrlC = 0;
	private everConnected = false;
	private connection: "connecting" | "connected" | "disconnected" = "connecting";
	private timer: NodeJS.Timeout | null = null;
	private commandsKey = "";
	private readonly files = new Map<string, { at: number; list: Promise<string[]> }>();
	private resolveDone: () => void = () => {};
	readonly done = new Promise<void>((r) => {
		this.resolveDone = r;
	});

	constructor(
		private readonly client: HappierClient,
		private readonly initialSession?: string,
		private readonly notify: NotifyOptions = { osc: true, bell: true },
		/** Start a session on this computer right away instead of showing the start screen. */
		private readonly launch?: LocalLaunch,
	) {
		// The alt-screen renderer enables terminal focus reporting and consumes the focus events in
		// its own input listener, which runs before ours. Observe them at the terminal instead.
		const terminal = new ProcessTerminal();
		const start = terminal.start.bind(terminal);
		terminal.start = (onInput, onResize) =>
			start((data) => {
				if (data === FOCUS_IN || data === FOCUS_OUT) this.onTerminalFocus(data === FOCUS_IN);
				onInput(data);
			}, onResize);
		this.tui = new TuiAltScreen(terminal, false, undefined, {
			scrollToEndIndicator: () => c.accent(" ↓ jump to latest "),
		});
		this.scroll = new ScrollView(this.view, { follow: "end", primary: true, scrollbar: "auto" });
		this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		this.editor.onSubmit = (text) => void this.submit(text);
		this.home = new Home(() => {
			const machines = [...this.client.machines.values()];
			const active = this.sortedSessions().filter((x) => x.active).length;
			const online = machines.filter((m) => m.active).length;
			const link = this.connection === "connected" ? c.ok("● connected") : this.connection === "connecting" ? c.warn("◌ connecting") : c.err("○ offline — retrying");
			return {
				sessions: this.visibleSessions(),
				hidden: this.hiddenCount(),
				showInactive: this.showInactive,
				hosts: machines.map((m) => ({ name: machineName(m), online: m.active })),
				hostOf: (x) => this.hostOf(x),
				unread: this.unread,
				currentId: this.currentId,
				frame: this.frame,
				rows: this.tui.terminal.rows - this.renderRequests(this.tui.terminal.columns).length,
				status: this.loaded
					? `${this.client.config.serverName}  ${link}${c.dim(`  ·  ${active} active session${active === 1 ? "" : "s"} · ${online} machine${online === 1 ? "" : "s"} online`)}`
					: c.dim(this.loadError || `Connecting to ${this.client.config.serverName}…`),
			};
		});
		this.home.onOpen = (id) => void this.openSession(id);
		this.home.onNew = () => this.run(() => this.newSession());
		this.home.onToggleInactive = () => {
			this.showInactive = !this.showInactive;
			this.tui.requestRender();
		};
		this.home.onBack = () => {
			if (this.currentId) void this.openSession(this.currentId);
		};

		this.chatRoot = new VStack([
			{ component: new Lines((w) => this.renderHeader(w)), basis: 1, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderRequests(w)), basis: "auto", shrink: 0 },
			{ component: this.editor, basis: "auto", shrink: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderFooter(w)), basis: 1, shrink: 0 },
		]);
		this.homeRoot = new VStack([
			{ component: this.home, basis: 0, grow: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderRequests(w)), basis: "auto", shrink: 0 },
		]);
		this.showHome();
		this.newSessionFlow = new NewSessionFlow({
			client: this.client,
			pick: (opts) => this.pick(opts),
			flash: (text, level, ms) => this.flash(text, level, ms),
			clearNotice: () => {
				this.notice = null;
			},
		});
		this.tui.addInputListener((data) => (this.onKey(data) ? { consume: true } : undefined));
	}

	// --- lifecycle ---

	async start(): Promise<void> {
		this.tui.start();
		this.wireClient();
		this.timer = setInterval(() => this.tick(), 120);

		try {
			await Promise.all([this.client.refreshSessions(), this.client.refreshMachines().catch(() => [])]);
			this.loaded = true;
		} catch (e) {
			this.loadError = `Could not load sessions: ${errorText(e)}`;
			this.tui.requestRender();
			this.client.connect();
			return;
		}
		this.client.connect();
		for (const s of this.client.sessions.values()) this.attention.set(s.id, attentionOf(s));

		// A session named on the command line opens directly; otherwise the start screen stays up.
		const wanted = this.initialSession;
		if (wanted) {
			const requested = this.sortedSessions().find((s) => s.id === wanted || s.id.startsWith(wanted) || s.metadata.tag === wanted);
			if (requested) await this.openSession(requested.id);
			else this.flash(`No session matches "${wanted}"`, "warn");
		} else if (this.launch) {
			const launch = this.launch;
			this.run(() => this.newSession(launch));
		}
		this.tui.requestRender();
	}

	/** Shows the start screen, which doubles as the session switcher. */
	private showHome(): void {
		this.mode = "home";
		this.home.reset();
		this.tui.setLayoutRoot(this.homeRoot);
		this.tui.setFocus(this.home);
		this.tui.requestRender();
	}

	private quit(): void {
		if (this.timer) clearInterval(this.timer);
		this.client.close();
		// The alt-screen renderer prints its document to the main screen on stop; leave nothing behind.
		this.tui.setLayoutRoot(new Lines(() => []));
		this.tui.stop();
		this.resolveDone();
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();
		let dirty = false;
		if (this.notice && this.notice.until < now) {
			this.notice = null;
			dirty = true;
		}
		for (const [id, at] of this.awaiting) {
			if (now - at > 90_000) {
				this.awaiting.delete(id);
				dirty = true;
			}
		}
		this.syncPresence();
		const anyBusy = [...this.client.sessions.values()].some((s) => this.busy(s));
		if (anyBusy) dirty = true;
		// The start screen's logo is animated.
		if (this.mode === "home" && !this.overlay) dirty = true;
		this.maybeLoadEarlier();
		if (dirty) this.tui.requestRender();
	}

	// --- client events ---

	private wireClient(): void {
		const cl = this.client;
		cl.on("connection", (state, detail) => {
			this.connection = state;
			if (state === "connected") {
				if (this.everConnected) void this.resync();
				this.everConnected = true;
			} else if (state === "disconnected" && detail && /token|auth/i.test(detail)) {
				this.flash(`Relay rejected the connection: ${detail}`, "error", 15_000);
			}
			this.tui.requestRender();
		});
		cl.on("session", (s) => {
			this.noteAttention(s);
			if (s.id === this.currentId) {
				if (isBusy(s)) this.awaiting.delete(s.id);
				this.refreshCommands(s);
				this.promptForRequests(s);
			}
			this.tui.requestRender();
		});
		cl.on("session-removed", (id) => {
			this.attention.delete(id);
			this.entries.delete(id);
			this.unread.delete(id);
			if (id === this.currentId) {
				this.currentId = null;
				this.view.setTranscript(null);
				this.showHome();
			}
			this.tui.requestRender();
		});
		cl.on("message", (sid, row) => {
			const entry = this.entries.get(sid);
			const isAgent = isRecordRole(row, "agent");
			if (isAgent) this.awaiting.delete(sid);
			if (entry?.loaded) entry.transcript.upsert(row, row.record);
			if (sid !== this.currentId) {
				if (isAgent) this.unread.add(sid);
			}
			this.tui.requestRender();
		});
		cl.on("stream-segment", (sid, row) => {
			const entry = this.entries.get(sid);
			this.awaiting.delete(sid);
			if (entry?.loaded && entry.transcript.upsert(row, row.record) && sid === this.currentId) {
				this.tui.requestRender();
			}
		});
		cl.on("stream-delta", (sid, localId, text, base) => {
			const entry = this.entries.get(sid);
			if (entry?.loaded && entry.transcript.appendDelta(localId, text, base) && sid === this.currentId) {
				this.tui.requestRender();
			}
		});
		cl.on("machine", () => this.tui.requestRender());
	}

	/** After a reconnect: updates may have been missed, so re-read what is on screen. */
	private async resync(): Promise<void> {
		try {
			await this.client.refreshSessions();
			for (const id of [...this.entries.keys()]) if (id !== this.currentId) this.entries.delete(id);
			const s = this.current();
			const entry = s && this.entries.get(s.id);
			if (s && entry?.loaded) await this.catchUp(s, entry);
		} catch (e) {
			this.flash(`Resync failed: ${errorText(e)}`, "warn");
		}
		this.tui.requestRender();
	}

	private async catchUp(s: Session, entry: Entry): Promise<void> {
		let after = entry.transcript.maxSeq ?? 0;
		for (let i = 0; i < 20; i++) {
			const page = await this.client.fetchMessages(s, { afterSeq: after, limit: 500 });
			for (const m of page.messages) entry.transcript.upsert(m, m.record);
			if (!page.hasMore || page.nextAfterSeq === null || page.nextAfterSeq <= after) break;
			after = page.nextAfterSeq;
		}
	}

	// --- sessions ---

	private current(): Session | undefined {
		return this.currentId ? this.client.sessions.get(this.currentId) : undefined;
	}

	/**
	 * Sessions listed by default: live ones, plus any that need an answer and the one on screen.
	 * Inactive sessions are shown on the start screen on demand (tab).
	 */
	private visibleSessions(): Session[] {
		const all = this.sortedSessions();
		if (this.showInactive) return all;
		return all.filter(
			(s) => s.active || s.id === this.currentId || s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0,
		);
	}

	private hiddenCount(): number {
		return this.sortedSessions().length - this.visibleSessions().length;
	}

	private sortedSessions(): Session[] {
		return sortSessions([...this.client.sessions.values()].filter((s) => !s.archivedAt));
	}

	private hostOf(s: Session): string {
		const m = typeof s.metadata.machineId === "string" ? this.client.machines.get(s.metadata.machineId) : undefined;
		return machineName(m) || shortHost(s.metadata.host) || "?";
	}

	private busy(s: Session): boolean {
		return isBusy(s) || this.awaiting.has(s.id);
	}

	async openSession(id: string): Promise<void> {
		const s = this.client.sessions.get(id);
		if (!s) return;
		this.currentId = id;
		this.unread.delete(id);
		if (this.mode !== "chat") {
			this.mode = "chat";
			this.tui.setLayoutRoot(this.chatRoot);
		}
		this.tui.setFocus(this.editor);
		let entry = this.entries.get(id);
		if (!entry) {
			entry = { transcript: new Transcript(), loaded: false, hasEarlier: false, nextBeforeSeq: null, loadingEarlier: false };
			this.entries.set(id, entry);
		}
		this.view.setTranscript(entry.transcript);
		this.view.hasEarlier = entry.hasEarlier;
		this.view.loadingEarlier = false;
		this.view.placeholder = entry.loaded ? "No messages yet. Type a prompt to start." : "Loading transcript…";
		this.refreshCommands(s);
		this.scroll.scrollToEnd();
		this.tui.requestRender();

		if (!entry.loaded) {
			if (!s.key) {
				this.view.placeholder = "This session is end-to-end encrypted and no matching key is available on this device.";
			} else {
				try {
					const page = await this.client.fetchMessages(s);
					for (const m of page.messages) entry.transcript.upsert(m, m.record);
					entry.loaded = true;
					entry.hasEarlier = page.hasMore && page.nextBeforeSeq !== null;
					entry.nextBeforeSeq = page.nextBeforeSeq;
					if (page.messages.some((m) => m.record === null)) {
						this.flash("Some messages could not be decrypted and are hidden.", "warn");
					}
					this.view.placeholder = isDirect(s)
						? "This is a direct session: its transcript lives on the machine, not the relay, and is not shown here yet."
						: "No messages yet. Type a prompt to start.";
				} catch (e) {
					this.view.placeholder = `Could not load transcript: ${errorText(e)}`;
				}
			}
			if (this.currentId !== id) return;
			this.view.hasEarlier = entry.hasEarlier;
			this.scroll.scrollToEnd();
		}
		this.promptForRequests(s);
		this.tui.requestRender();
	}

	private maybeLoadEarlier(): void {
		const s = this.current();
		const entry = s && this.entries.get(s.id);
		if (!s || !entry?.loaded || !entry.hasEarlier || entry.loadingEarlier || entry.nextBeforeSeq === null) return;
		const height = this.view.render(this.view.lastWidth).length;
		const atTop = this.scroll.scrollTop === 0 && (!this.scroll.isFollowingEnd || height <= this.scroll.viewportHeight);
		if (!atTop || this.scroll.viewportHeight === 0) return;
		void this.loadEarlier(s, entry);
	}

	private async loadEarlier(s: Session, entry: Entry): Promise<void> {
		entry.loadingEarlier = true;
		this.view.loadingEarlier = true;
		this.tui.requestRender();
		try {
			const before = this.view.render(this.view.lastWidth).length;
			const page = await this.client.fetchMessages(s, { beforeSeq: entry.nextBeforeSeq ?? undefined });
			for (const m of page.messages) entry.transcript.upsert(m, m.record);
			entry.hasEarlier = page.hasMore && page.nextBeforeSeq !== null;
			entry.nextBeforeSeq = page.nextBeforeSeq;
			if (this.currentId === s.id) {
				this.view.hasEarlier = entry.hasEarlier;
				this.view.loadingEarlier = false;
				const added = this.view.render(this.view.lastWidth).length - before;
				if (!this.scroll.isFollowingEnd && added > 0) {
					this.scroll.scrollTo(this.scroll.scrollTop + added, { disableFollow: true });
				}
			}
		} catch (e) {
			entry.hasEarlier = false;
			this.view.hasEarlier = false;
			this.flash(`Could not load earlier messages: ${errorText(e)}`, "warn");
		} finally {
			entry.loadingEarlier = false;
			this.view.loadingEarlier = false;
			this.tui.requestRender();
		}
	}

	private refreshCommands(s: Session): void {
		const remote: SlashCommand[] = [];
		const details = Array.isArray(s.metadata.slashCommandDetails) ? s.metadata.slashCommandDetails : [];
		const names = Array.isArray(s.metadata.slashCommands) ? s.metadata.slashCommands : [];
		const seen = new Set(LOCAL_COMMANDS.map((x) => x.name));
		for (const d of [...details, ...names]) {
			const name = typeof d === "string" ? d : isObj(d) && typeof d.name === "string" ? d.name : "";
			const clean = name.replace(/^\//, "");
			if (!clean || seen.has(clean)) continue;
			seen.add(clean);
			const description = isObj(d) && typeof d.description === "string" ? d.description : "agent command";
			remote.push({ name: clean, description });
		}
		const key = `${s.id}:${remote.length}`;
		if (key === this.commandsKey) return;
		this.commandsKey = key;
		void this.sessionFiles(s); // warm the `@` index; a large tree takes seconds to list
		this.editor.setAutocompleteProvider(new SessionAutocomplete([...LOCAL_COMMANDS, ...remote], () => this.sessionFiles(s)));
	}

	/** The session's file list for `@` completion, fetched once per session and kept for a minute. */
	private sessionFiles(s: Session): Promise<string[]> {
		const cached = this.files.get(s.id);
		if (cached && Date.now() - cached.at < 60_000) return cached.list;
		const list = this.client.listFiles(s).catch((e) => {
			debug(`file list for ${s.id}: ${errorText(e)}`);
			return [] as string[];
		});
		this.files.set(s.id, { at: Date.now(), list });
		return list;
	}

	// --- input ---

	/** Global keys. Returns true when the key was handled and must not reach the focused component. */
	private onKey(data: string): boolean {
		// Terminals speaking the Kitty keyboard protocol report press, repeat and release as separate
		// events. Input listeners see all of them (the library only filters releases for the focused
		// component), so act on the press alone — otherwise every toggle fires twice and undoes itself.
		this.lastInputAt = Date.now();
		if (isKeyRelease(data) || isKeyRepeat(data)) return false;
		if (this.overlay) return false;
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.mode === "chat" && this.editor.getText()) {
				this.editor.setText("");
				return true;
			}
			const now = Date.now();
			if (now - this.lastCtrlC < 1500) this.quit();
			else {
				this.lastCtrlC = now;
				this.flash("Press ctrl+c again to quit", "info", 1500);
			}
			return true;
		}
		if (matchesKey(data, Key.ctrl("n"))) return this.run(() => this.newSession());
		// Everything else on the start screen belongs to its own list and search box.
		if (this.mode === "home") return false;
		if (matchesKey(data, Key.ctrl("d")) && !this.editor.getText()) {
			this.quit();
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			const s = this.current();
			if (this.editor.isShowingAutocomplete() || !s || !this.busy(s)) return false;
			void this.abort();
			return true;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.showHome();
			return true;
		}
		if (matchesKey(data, Key.ctrl("r"))) return this.run(() => this.answerRequest());
		if (matchesKey(data, Key.ctrl("o"))) {
			this.relayout(() => {
				this.view.options.expandTools = !this.view.options.expandTools;
			});
			this.flash(this.view.options.expandTools ? "Tool output expanded" : "Tool output collapsed", "info", 1500);
			return true;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			this.relayout(() => {
				this.view.options.showThinking = !this.view.options.showThinking;
			});
			this.flash(this.view.options.showThinking ? "Thinking shown" : "Thinking hidden", "info", 1500);
			return true;
		}
		if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
			const list = this.visibleSessions();
			const i = list.findIndex((s) => s.id === this.currentId);
			const next = list[(i + (matchesKey(data, Key.alt("up")) ? -1 : 1) + list.length) % list.length];
			if (next) void this.openSession(next.id);
			return true;
		}
		return false;
	}

	/**
	 * Applies a change that alters row heights while keeping the same message at the top of the
	 * viewport. When the view is following the end it simply stays at the end.
	 */
	private relayout(change: () => void): void {
		const following = this.scroll.isFollowingEnd;
		this.view.render(this.view.lastWidth);
		const anchor = following ? null : this.view.anchorAt(this.scroll.scrollTop);
		change();
		if (anchor) {
			const before = this.view.render(this.view.lastWidth).length;
			const start = this.view.lineOf(anchor.key);
			if (start !== null && before > 0) this.scroll.scrollTo(start + anchor.offset, { disableFollow: true });
		}
		this.tui.requestRender();
	}

	private run(fn: () => Promise<void>): boolean {
		fn().catch((e) => this.flash(errorText(e), "error", 8000));
		return true;
	}

	private async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.addToHistory(text);
		const cmd = /^\/([\w-]+)\s*(.*)$/.exec(text);
		if (cmd && LOCAL_COMMANDS.some((x) => x.name === cmd[1])) {
			this.run(() => this.command(cmd[1]!, cmd[2] ?? ""));
			return;
		}
		const s = this.current();
		const entry = s && this.entries.get(s.id);
		if (!s || !entry) {
			this.flash("No session open — ctrl+s for the session list.", "warn");
			this.editor.setText(raw);
			return;
		}
		try {
			const { localId, record } = await this.client.sendMessage(s, text);
			entry.transcript.upsert({ localId, createdAt: Date.now() }, record);
			this.awaiting.set(s.id, Date.now());
			this.scroll.scrollToEnd();
			if (!s.active) this.flash("Session is inactive — asked its machine to resume it.", "info", 6000);
		} catch (e) {
			this.editor.setText(raw);
			this.flash(`Send failed: ${errorText(e)}`, "error", 10_000);
		}
		this.tui.requestRender();
	}

	private async command(name: string, arg: string): Promise<void> {
		const s = this.current();
		switch (name) {
			case "sessions":
				this.showHome();
				return;
			case "new-session":
				return this.newSession();
			case "abort":
				return this.abort();
			case "keys":
				this.flash(KEYS_HELP, "info", 20_000);
				return;
			case "quit":
				this.quit();
				return;
			case "reload": {
				await Promise.all([this.client.refreshSessions(), this.client.refreshMachines()]);
				if (s) {
					this.entries.delete(s.id);
					await this.openSession(s.id);
				}
				this.flash("Reloaded.", "info");
				return;
			}
			case "mode": {
				if (!s) return;
				const current = typeof s.metadata.permissionMode === "string" ? s.metadata.permissionMode : "default";
				const mode = PERMISSION_MODES.includes(arg)
					? arg
					: await this.pick({
							title: "Permission mode",
							noFilter: true,
							selected: current,
							items: PERMISSION_MODES.map((m) => ({ value: m, label: m, description: m === current ? "current" : "" })),
						});
				if (!mode) return;
				await this.client.setPermissionMode(s, mode);
				this.flash(`Permission mode: ${mode} (applies from your next message)`, "info");
				return;
			}
			case "model": {
				if (!s) return;
				const { current, available: reported } = sessionModels(s);
				let available = reported;
				if (available.length === 0 && !arg) {
					// A fresh session has not reported its models yet; ask its machine instead.
					const machineId = s.metadata.machineId;
					const machine = typeof machineId === "string" ? await this.client.getMachine(machineId) : undefined;
					const agent = typeof s.metadata.flavor === "string" ? s.metadata.flavor : "";
					if (machine?.active && agent) {
						this.flash(`Asking ${machineName(machine)} for ${agent} models…`, "info", 60_000);
						const cwd = typeof s.metadata.path === "string" ? s.metadata.path : undefined;
						available = await this.client.probeModels(machine, agent, cwd).catch(() => []);
						this.notice = null;
					}
				}
				if (available.length === 0 && !arg) {
					this.flash("Could not get a model list for this session. Use /model <model-id> to set one by id.", "warn", 8000);
					return;
				}
				const match = arg && (available.find((m) => m.id === arg || m.name === arg)?.id ?? arg);
				const model =
					match ||
					(await this.pick({
						title: `Model (${available.length})`,
						selected: current,
						maxVisible: 14,
						items: available.map((m) => ({
							value: m.id,
							label: m.name,
							description: [m.description, m.id === current ? "current" : ""].filter(Boolean).join(" · "),
						})),
					}));
				if (!model || model === current) return;
				await this.client.setModel(s, model);
				this.flash(`Model: ${model} (applies from your next message)`, "info");
				return;
			}
			case "stop-session": {
				if (!s) return;
				if (!(await this.confirm(`Stop the agent process for "${sessionTitle(s)}"?`))) return;
				await this.client.stopSession(s);
				this.flash("Stop requested.", "info");
				return;
			}
			case "archive": {
				if (!s) return;
				if (!(await this.confirm(`Archive "${sessionTitle(s)}"?`))) return;
				try {
					await this.client.archive(s);
				} catch (e) {
					if (e instanceof HappierError && e.code === "session-active") {
						throw new HappierError("Session is still running — /stop-session first, then /archive.");
					}
					throw e;
				}
				this.flash("Archived.", "info");
				return;
			}
		}
	}

	private async abort(): Promise<void> {
		const s = this.current();
		if (!s) return;
		this.awaiting.delete(s.id);
		const ok = await this.client.abort(s);
		this.flash(ok ? "Interrupt sent." : "Nothing to interrupt (no agent attached).", ok ? "info" : "warn");
	}

	// --- overlays ---

	private pick(opts: Omit<PickerOptions, "onSelect" | "onCancel">): Promise<string | null> {
		return new Promise((resolve) => {
			const close = (value: string | null) => {
				this.overlay?.hide();
				this.overlay = null;
				this.tui.setFocus(this.mode === "home" ? this.home : this.editor);
				this.tui.requestRender();
				resolve(value);
			};
			const picker = new Picker({ ...opts, onSelect: (item) => close(item.value), onCancel: () => close(null) });
			this.overlay?.hide();
			this.overlay = this.tui.showOverlay(picker, { width: "70%", minWidth: 44, maxHeight: "80%", anchor: "center" });
		});
	}

	private async confirm(question: string): Promise<boolean> {
		const v = await this.pick({
			title: question,
			noFilter: true,
			items: [
				{ value: "no", label: "No" },
				{ value: "yes", label: "Yes" },
			],
		});
		return v === "yes";
	}

	private promptForRequests(s: Session): void {
		if (this.overlay || this.mode !== "chat" || s.id !== this.currentId) return;
		const next = pendingRequests(s).find((r) => !this.prompted.has(`${s.id}:${r.id}`));
		if (!next) return;
		this.prompted.add(`${s.id}:${next.id}`);
		this.run(() => this.answer(s, next));
	}

	private async answerRequest(): Promise<void> {
		const s = this.current();
		const req = s && pendingRequests(s)[0];
		if (!s || !req) {
			this.flash("No pending permission request in this session.", "info");
			return;
		}
		await this.answer(s, req);
	}

	private async answer(s: Session, req: PermissionRequest): Promise<void> {
		const questions = questionsOf(req);
		if (questions.length > 0) {
			const answers: Record<string, string[]> = {};
			for (const q of questions) {
				const choice = await this.pick({
					title: q.question,
					noFilter: true,
					items: q.options,
					hint: "esc to answer later (ctrl+r)",
				});
				if (choice === null) return;
				answers[q.question] = [choice];
			}
			await this.client.respondQuestion(s, req, answers);
			return;
		}
		const detail = requestSummary(req);
		const choice = await this.pick({
			title: `Allow ${req.tool}?`,
			noFilter: true,
			hint: detail ? `${detail}   ·   esc to decide later (ctrl+r)` : "esc to decide later (ctrl+r)",
			items: [
				{ value: "approved", label: "Allow once" },
				{ value: "approved_for_session", label: `Always allow ${req.tool} in this session` },
				{ value: "denied", label: "Deny" },
				{ value: "abort", label: "Deny and stop the turn" },
			],
		});
		if (!choice) return;
		await this.client.respondPermission(s, req, choice as "approved" | "approved_for_session" | "denied" | "abort");
	}

	private async newSession(local?: LocalLaunch): Promise<void> {
		const sessionId = await this.newSessionFlow.run(local);
		if (sessionId) await this.openSession(sessionId);
	}

	// --- attention ---

	private onTerminalFocus(focused: boolean): void {
		this.focusKnown = true;
		this.focused = focused;
		if (focused) this.lastInputAt = Date.now();
		debug(`terminal focus ${focused ? "in" : "out"}`);
		// Leaving must lift the phone mute right away, not on the next tick.
		this.syncPresence();
	}

	/** The user is at this terminal: it has focus and they typed or scrolled recently. */
	private present(): boolean {
		return this.focused && Date.now() - this.lastInputAt < PRESENCE_IDLE_MS;
	}

	private readonly readUpTo = new Map<string, number>();

	/** Reports presence to the relay (phone-push muting) and advances the read cursor of the open session. */
	private syncPresence(): void {
		const present = this.present();
		this.client.setUiFocus(present);
		const s = this.current();
		if (!present || this.mode !== "chat" || !s || !this.entries.get(s.id)?.loaded) return;
		if (s.seq > (this.readUpTo.get(s.id) ?? 0)) {
			this.readUpTo.set(s.id, s.seq);
			this.client.markRead(s, s.seq);
		}
	}

	/** True when the user is looking at this session right now. */
	private watching(sessionId: string): boolean {
		// Without focus reporting we cannot tell whether the user is looking, so we never claim it:
		// the notification is emitted and the terminal decides whether a focused pane needs a banner.
		return this.focusKnown && this.present() && this.mode === "chat" && sessionId === this.currentId;
	}

	/**
	 * Raises a terminal notification when a session starts needing the user (permission request,
	 * question) or finishes its turn, unless they are already looking at it.
	 */
	private noteAttention(s: Session): void {
		const next = attentionOf(s);
		const prev = this.attention.get(s.id);
		const change = attentionChange(prev, next);
		this.attention.set(s.id, next);
		if (prev && (prev.busy !== next.busy || prev.turnStatus !== next.turnStatus || prev.requestIds.length !== next.requestIds.length)) {
			debug(
				`session ${s.id.slice(0, 8)} busy ${prev.busy}->${next.busy} turn ${prev.turnStatus}->${next.turnStatus} requests ${prev.requestIds.length}->${next.requestIds.length} => ${change ? change.kind : "no change"}; focused=${this.focused} present=${this.present()} current=${s.id === this.currentId} notify=${Boolean(change && (this.notify.osc || this.notify.bell) && !this.watching(s.id))}`,
			);
		}
		if (!change || !(this.notify.osc || this.notify.bell) || this.watching(s.id)) return;
		let body: string;
		if (change.kind === "request") {
			const req = pendingRequests(s).find((r) => r.id === change.requestId);
			const detail = req ? requestSummary(req) : "";
			body = req && questionsOf(req).length ? "Has a question for you" : `Needs permission: ${req?.tool ?? "tool"}${detail ? ` — ${detail}` : ""}`;
		} else {
			body = change.failed ? "Turn failed" : "Finished — waiting for you";
		}
		this.tui.terminal.write(notificationSequence(`${sessionTitle(s)} · ${this.hostOf(s)}`, body, this.notify));
	}

	// --- chrome ---

	private flash(text: string, level: "info" | "warn" | "error" = "info", ms = 4000): void {
		this.notice = { text, level, until: Date.now() + ms };
		this.tui.requestRender();
	}

	private renderHeader(width: number): string[] {
		const s = this.current();
		const conn =
			this.connection === "connected"
				? c.ok("● connected")
				: this.connection === "connecting"
					? c.warn("◌ connecting")
					: c.err("○ offline — retrying");
		let left = ` ${c.accent.bold("happier")}`;
		if (s) {
			left += `  ${statusGlyph(s, this.frame)} ${c.bold(clean(sessionTitle(s)).replace(/\s+/g, " "))}`;
			left += c.dim(`  ${s.metadata.flavor ?? "?"} · ${this.hostOf(s)} · ${shortPath(s.metadata.path, s.metadata.homeDir)}`);
		} else {
			left += c.dim(`  ${this.client.config.serverName}`);
		}
		return [c.headerBg(justify(left, `${conn} `, width))];
	}

	private renderRequests(width: number): string[] {
		const lines: string[] = [];
		const s = this.current();
		if (s) {
			const reqs = pendingRequests(s);
			const first = reqs[0];
			if (first) {
				const more = reqs.length > 1 ? c.dim(` (+${reqs.length - 1} more)`) : "";
				const what = questionsOf(first).length ? "Question from the agent" : `Permission: ${first.tool} ${c.dim(requestSummary(first))}`;
				lines.push(` ${c.warn("⚠")} ${what}${more}`);
				lines.push(c.dim("   ctrl+r to answer"));
			}
		}
		if (this.notice) {
			const color = this.notice.level === "error" ? c.err : this.notice.level === "warn" ? c.warn : c.accent;
			for (const part of this.notice.text.split("\n")) {
				for (const l of wrapTextWithAnsi(part, Math.max(10, width - 2))) lines.push(` ${color(l)}`);
			}
		}
		return lines;
	}

	private renderFooter(width: number): string[] {
		const s = this.current();
		if (!s) return [justify(c.dim(" ctrl+s sessions · ctrl+n new session"), c.dim("/keys "), width)];
		const parts: string[] = [];
		const mode = typeof s.metadata.permissionMode === "string" ? s.metadata.permissionMode : "default";
		parts.push(mode === "yolo" || mode === "bypassPermissions" ? c.err(mode) : c.dim(mode));
		const model = sessionModels(s).current;
		if (model) parts.push(c.dim(model));
		const usage = this.entries.get(s.id)?.transcript.usage;
		if (usage?.contextUsed && usage.contextWindow) {
			const pct = Math.round((usage.contextUsed / usage.contextWindow) * 100);
			parts.push((pct >= 85 ? c.warn : c.dim)(`ctx ${pct}%`));
		}
		if (s.pendingCount > 0) parts.push(c.dim(`${s.pendingCount} queued`));
		let state: string;
		if (this.busy(s)) state = c.warn(`${SPINNER[this.frame % SPINNER.length]} working`) + c.dim(" · esc to interrupt");
		else if (!s.active) state = c.dim("inactive · sending resumes it");
		else state = c.ok("ready");
		return [justify(` ${state}${c.dim("  ·  ")}${parts.join(c.dim(" · "))}`, c.dim("ctrl+s sessions · /keys "), width)];
	}
}

// --- helpers -----------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function isDirect(s: Session): boolean {
	return isObj(s.metadata.directSessionV1) && s.seq === 0;
}

function isRecordRole(row: MessageRow, role: string): boolean {
	return isObj(row.record) && row.record.role === role;
}

function attentionOf(s: Session): AttentionState {
	return { busy: isBusy(s), requestIds: pendingRequests(s).map((r) => r.id), turnStatus: s.latestTurnStatus };
}
