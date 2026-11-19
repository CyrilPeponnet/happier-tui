/**
 * Turns decrypted Happier transcript records into a flat list of display items.
 *
 * A decrypted record is `{ role: 'user' | 'agent', content, meta? }`. Agent content is one of
 *   output : raw Claude SDK/JSONL object in `data`
 *   acp    : `{ provider, data: { type: message | thinking | tool-call | tool-result | ... } }`
 *   codex  : same event vocabulary as acp, older tool-result spelling
 *   event  : session events (ready, switch, message, limit-reached, ...)
 * Reference: apps/ui/sources/sync/typesRaw/normalize.ts and
 * packages/protocol/src/sessionMessages/transcriptRawRecordV1.ts upstream.
 */

export type Item =
	| { kind: "user"; text: string; sentFrom?: string }
	| { kind: "text"; text: string; streaming?: boolean }
	| { kind: "thinking"; text: string; streaming?: boolean }
	| { kind: "tool"; callId: string; name: string; input: unknown; description?: string }
	| { kind: "notice"; text: string; level: "info" | "warn" | "error" };

export interface ToolResult {
	output: unknown;
	isError: boolean;
}

export interface Usage {
	contextUsed?: number;
	contextWindow?: number;
	cost?: number;
}

/** What one record contributes besides visible items. */
export interface Normalized {
	items: Item[];
	results: Array<{ callId: string; result: ToolResult }>;
	usage?: Usage;
	/** Text of a turn failure, so the same text reported as terminal output is not shown twice. */
	failure?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function maybeJson(v: unknown): unknown {
	if (typeof v !== "string") return v;
	const t = v.trim();
	if (!t.startsWith("{") && !t.startsWith("[")) return v;
	try {
		return JSON.parse(t);
	} catch {
		return v;
	}
}

const HIDDEN_USER_PREFIXES = [
	"<local-command-caveat>",
	"<command-name>",
	"<local-command-stdout>",
	"<task-notification>",
	"<system-reminder>",
];

function empty(): Normalized {
	return { items: [], results: [] };
}

export function normalizeRecord(record: unknown): Normalized {
	const out = empty();
	if (!isObj(record)) return out;
	const content = record.content;
	const meta = isObj(record.meta) ? record.meta : {};
	if (!isObj(content)) return out;

	if (record.role === "user") {
		const happier = isObj(meta.happier) ? meta.happier : undefined;
		if (happier?.kind === "tool-answer-delivery.v1") return out;
		const text = str(meta.displayText) ?? str(content.text);
		if (content.type === "text" && text?.trim()) {
			out.items.push({ kind: "user", text, sentFrom: str(meta.sentFrom) });
		}
		return out;
	}
	if (record.role !== "agent") return out;

	const segment = isObj(meta.happierStreamSegmentV1) ? meta.happierStreamSegmentV1 : undefined;
	const streaming = segment?.segmentState === "streaming";

	switch (content.type) {
		case "acp":
		case "codex":
			normalizeAcp(content.data, out, streaming, content.type === "codex");
			break;
		case "output":
			normalizeClaudeOutput(content.data, out);
			break;
		case "event":
			normalizeEvent(content.data, out);
			break;
		default:
			break;
	}
	return out;
}

function normalizeAcp(data: unknown, out: Normalized, streaming: boolean, codex: boolean): void {
	if (!isObj(data)) return;
	const type = str(data.type) ?? "";
	switch (type) {
		case "message": {
			const text = str(data.message);
			if (text) out.items.push({ kind: "text", text, streaming });
			return;
		}
		case "reasoning": {
			const text = str(data.message);
			if (text) out.items.push(codex ? { kind: "thinking", text, streaming } : { kind: "text", text, streaming });
			return;
		}
		case "thinking": {
			const text = str(data.text);
			if (text) out.items.push({ kind: "thinking", text, streaming });
			return;
		}
		case "tool-call": {
			const callId = str(data.callId) ?? str(data.id);
			if (!callId) return;
			const input = maybeJson(data.input);
			out.items.push({
				kind: "tool",
				callId,
				name: str(data.name) ?? "tool",
				input,
				description: toolDescription(input),
			});
			return;
		}
		case "tool-result":
		case "tool-call-result": {
			const callId = str(data.callId);
			if (callId) {
				out.results.push({ callId, result: { output: maybeJson(data.output), isError: data.isError === true } });
			}
			return;
		}
		case "terminal-output": {
			const callId = str(data.callId);
			if (callId) out.results.push({ callId, result: { output: data.data, isError: false } });
			return;
		}
		case "file-edit": {
			const id = str(data.id);
			if (!id) return;
			out.items.push({
				kind: "tool",
				callId: id,
				name: "Edit",
				input: { file_path: data.filePath, diff: data.diff },
				description: str(data.description),
			});
			return;
		}
		case "token_count": {
			const tokens = isObj(data.tokens) ? data.tokens : data;
			const cost = isObj(data.cost) ? num(data.cost.total) : undefined;
			out.usage = {
				contextUsed: num(tokens.context_used_tokens),
				contextWindow: num(tokens.context_window_tokens),
				cost,
			};
			return;
		}
		case "turn_failed": {
			const issue = isObj(data.issue) ? str(data.issue.sanitizedPreview) : undefined;
			if (issue) out.failure = issue;
			out.items.push({ kind: "notice", text: issue ? `Turn failed: ${issue}` : "Turn failed", level: "error" });
			return;
		}
		case "turn_aborted":
		case "turn_cancelled":
			out.items.push({ kind: "notice", text: "Turn aborted", level: "warn" });
			return;
		case "context-compaction": {
			const phase = str(data.phase);
			if (phase === "started" || phase === "completed" || phase === "failed") {
				out.items.push({ kind: "notice", text: `Context compaction ${phase}`, level: "info" });
			}
			return;
		}
		default:
			// Turn lifecycle markers (task_started, task_complete) and unknown types carry nothing to show.
			return;
	}
}

function normalizeClaudeOutput(data: unknown, out: Normalized): void {
	if (!isObj(data)) return;
	if (data.isMeta === true || data.isCompactSummary === true) return;
	const type = str(data.type);
	if (type === "summary") {
		const text = str(data.summary);
		if (text) out.items.push({ kind: "notice", text: `Summary: ${text}`, level: "info" });
		return;
	}
	if (type !== "assistant" && type !== "user") return;
	const message = isObj(data.message) ? data.message : undefined;
	if (!message) return;
	const usage = isObj(message.usage) ? message.usage : undefined;
	if (usage && num(usage.context_used_tokens)) {
		out.usage = { contextUsed: num(usage.context_used_tokens), contextWindow: num(usage.context_window_tokens) };
	}
	const blocks = message.content;

	if (typeof blocks === "string") {
		if (!blocks.trim() || HIDDEN_USER_PREFIXES.some((p) => blocks.startsWith(p))) return;
		// A plain `user` output record is the prompt echoed by Claude; the role:'user' record already shows it.
		if (type === "assistant") out.items.push({ kind: "text", text: blocks });
		return;
	}
	if (!Array.isArray(blocks)) return;

	for (const block of blocks) {
		if (!isObj(block)) continue;
		switch (block.type) {
			case "text": {
				const text = str(block.text);
				if (type === "assistant" && text?.trim()) out.items.push({ kind: "text", text });
				break;
			}
			case "thinking": {
				const text = str(block.thinking);
				if (text?.trim()) out.items.push({ kind: "thinking", text });
				break;
			}
			case "tool_use":
			case "tool-call": {
				const callId = str(block.id) ?? str(block.callId);
				if (!callId) break;
				out.items.push({
					kind: "tool",
					callId,
					name: str(block.name) ?? "tool",
					input: block.input,
					description: toolDescription(block.input),
				});
				break;
			}
			case "tool_result":
			case "tool-call-result": {
				const callId = str(block.tool_use_id) ?? str(block.callId);
				if (!callId) break;
				out.results.push({
					callId,
					result: { output: block.content ?? block.output ?? data.toolUseResult, isError: block.is_error === true },
				});
				break;
			}
			default:
				break;
		}
	}
}

function normalizeEvent(data: unknown, out: Normalized): void {
	if (!isObj(data)) return;
	switch (data.type) {
		case "message": {
			const text = str(data.message);
			if (text) out.items.push({ kind: "notice", text, level: "info" });
			return;
		}
		case "switch":
			out.items.push({ kind: "notice", text: `Switched to ${str(data.mode) ?? "?"} mode`, level: "info" });
			return;
		case "limit-reached": {
			const endsAt = num(data.endsAt);
			const when = endsAt
				? ` — resets at ${new Date(endsAt * (endsAt < 1e12 ? 1000 : 1)).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
				: "";
			out.items.push({ kind: "notice", text: `Usage limit reached${when}. /limit to resume automatically.`, level: "warn" });
			return;
		}
		case "context-compaction": {
			const phase = str(data.phase);
			if (phase === "started" || phase === "completed" || phase === "failed") {
				out.items.push({ kind: "notice", text: `Context compaction ${phase}`, level: "info" });
			}
			return;
		}
		case "runtime-config-outcome": {
			const text = str(data.message);
			if (text) out.items.push({ kind: "notice", text, level: data.status === "failed" ? "error" : "info" });
			return;
		}
		default:
			return;
	}
}

function toolDescription(input: unknown): string | undefined {
	if (!isObj(input)) return undefined;
	const acp = isObj(input._acp) ? str(input._acp.title) : undefined;
	return acp ?? str(input.description);
}

// --- presentation helpers (pure, shared by the UI) ---------------------------

const ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "title", "prompt"];

/**
 * One-line summary of a tool invocation. `arg` is what it is for: the agent's own description of
 * the step when it gave one (Claude's Bash and Task), else the main argument. `detail` is that
 * main argument when the description took its place, e.g. the command line.
 */
export function toolSummary(item: Extract<Item, { kind: "tool" }>): { name: string; arg: string; detail?: string } {
	const input = isObj(item.input) ? item.input : {};
	const flat = (v: string) => v.replace(/\s+/g, " ").trim();
	const main = ARG_KEYS.map((k) => str(input[k])).find((v) => v?.trim()) ?? (typeof item.input === "string" ? item.input : "");
	const description = item.description?.trim();
	if (description && main && flat(main) !== flat(description)) return { name: item.name, arg: flat(description), detail: flat(main) };
	return { name: item.name, arg: flat(description || main) };
}

/**
 * Providers report raw terminal/provider output as a pseudo tool named `terminal-output` with no
 * input. It is shown as plain output rather than as a tool invocation.
 */
export function isTerminalOutput(item: Extract<Item, { kind: "tool" }>): boolean {
	return item.name === "terminal-output";
}

/** A unified diff of Claude's `structuredPatch` hunks. */
function patchText(hunks: unknown[]): string {
	return hunks
		.filter(isObj)
		.flatMap((h) => [
			`@@ -${num(h.oldStart) ?? 0},${num(h.oldLines) ?? 0} +${num(h.newStart) ?? 0},${num(h.newLines) ?? 0} @@`,
			...(Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : []),
		])
		.join("\n");
}

/** Readable text for the Claude tool outcomes that have one, else null (use `content`). */
function claudeResultText(r: Obj): string | null {
	if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) return patchText(r.structuredPatch);
	// Read: the file body is for the model; say how much was read, as Claude Code does.
	if (r.type === "text" && isObj(r.file)) {
		const lines = num(r.file.numLines) ?? 0;
		return `Read ${lines} line${lines === 1 ? "" : "s"}`;
	}
	if (typeof r.stdout === "string" || typeof r.stderr === "string") {
		const out = [str(r.stdout), str(r.stderr)].filter((x): x is string => !!x?.trim()).join("\n");
		if (r.interrupted === true) return `${out}\n(interrupted)`.trim();
		return out || (r.noOutputExpected === true ? "" : "(no output)");
	}
	return null;
}

/** Best-effort plain text of a tool result. */
export function toolResultText(output: unknown): string {
	if (output == null) return "";
	if (typeof output === "string") {
		// MCP tools often return a JSON object as text.
		if (/^\s*\{[\s\S]*\}\s*$/.test(output)) {
			try {
				const parsed: unknown = JSON.parse(output);
				if (isObj(parsed)) return toolResultText(parsed);
			} catch {
				// not JSON after all
			}
		}
		return output;
	}
	if (Array.isArray(output)) {
		const parts = output
			.map((b) => (typeof b === "string" ? b : isObj(b) ? (str(b.text) ?? str(b.tool_name) ?? "") : ""))
			.filter(Boolean);
		return parts.length === 1 ? toolResultText(parts[0]) : parts.join("\n");
	}
	if (isObj(output)) {
		// Claude: `content` is what the model saw, `tool_use_result` the structured outcome.
		if (isObj(output.tool_use_result)) {
			const structured = claudeResultText(output.tool_use_result);
			if (structured !== null) return structured;
		}
		if (typeof output.content === "string") return output.content;
		const details = isObj(output.details) ? output.details : undefined;
		const diff = str(details?.diff) ?? str(output.diff);
		if (diff) return diff;
		if (Array.isArray(output.content)) {
			const text = toolResultText(output.content);
			if (text) return text;
		}
		for (const key of ["stdout", "output", "text", "value", "error", "message", "stderr"]) {
			const v = str(output[key]);
			if (v) return v;
		}
		const { _happier, _raw, _acp, ...rest } = output;
		void _happier;
		void _raw;
		void _acp;
		// Anything else: one `key: value` line per field, which reads better than JSON.
		return Object.entries(rest)
			.filter(([, v]) => v !== undefined && v !== null && v !== "")
			.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
			.join("\n");
	}
	return String(output);
}

/**
 * Agents offer choices as `<options><option>…</option></options>` in their text; the Happier
 * apps show them as buttons that send the option as the next message. Returns the text without
 * those blocks, and the options in order.
 */
export function splitOptions(text: string): { text: string; options: string[] } {
	const options: string[] = [];
	const rest = text.replace(/<options>([\s\S]*?)<\/options>/g, (_m, inner: string) => {
		for (const m of inner.matchAll(/<option>([\s\S]*?)<\/option>/g)) {
			const option = (m[1] ?? "").trim();
			if (option) options.push(option);
		}
		return "";
	});
	return { text: rest.trimEnd(), options };
}

/** The choices the agent offered in its latest turn, if any. */
export function latestOptions(t: Transcript): { key: string; options: string[] } | undefined {
	const rows = t.list();
	for (let i = rows.length - 1; i >= 0; i--) {
		const items = rows[i]!.items;
		if (items[0]?.kind === "user") return undefined;
		for (let j = items.length - 1; j >= 0; j--) {
			const item = items[j]!;
			if (item.kind !== "text") continue;
			const { options } = splitOptions(item.text);
			// The row key stays the same when a streamed reply is saved, so it identifies the offer.
			if (options.length > 0) return { key: rows[i]!.key, options };
		}
	}
	return undefined;
}

// --- ordered transcript store ------------------------------------------------

export interface Row {
	/** Stable identity: `localId` when present (streamed segments are re-committed under it), else the row id. */
	key: string;
	/** Session sequence; undefined for live stream segments that are not durable yet. */
	seq?: number;
	createdAt: number;
	items: Item[];
}

export class Transcript {
	private rows = new Map<string, Row>();
	private ordered: Row[] | null = null;
	readonly results = new Map<string, ToolResult>();
	/** Failure texts already shown as a "Turn failed" notice. */
	readonly failures = new Set<string>();
	usage: Usage = {};
	minSeq: number | undefined;
	maxSeq: number | undefined;
	/** Subagent transcripts, keyed by the id of the tool call that started each one. */
	readonly sidechains = new Map<string, Transcript>();
	/** Bumped on every visible change, so views can tell when a subagent made progress. */
	version = 0;

	sidechain(id: string): Transcript {
		let t = this.sidechains.get(id);
		if (!t) this.sidechains.set(id, (t = new Transcript()));
		return t;
	}

	/**
	 * Inserts or replaces one decrypted record. A subagent's record goes to its own transcript.
	 * Returns true when something visible changed.
	 */
	upsert(
		row: { id?: string; localId?: string | null; seq?: number; createdAt: number; sidechainId?: string | null },
		record: unknown,
	): boolean {
		const side = row.sidechainId ?? claudeParentToolUseId(record);
		if (side) {
			const sub = this.sidechain(side);
			const changed = sub.apply(row, record);
			if (changed) {
				sub.version++;
				this.version++;
			}
			return changed;
		}
		const changed = this.apply(row, record);
		if (changed) this.version++;
		return changed;
	}

	private apply(row: { id?: string; localId?: string | null; seq?: number; createdAt: number }, record: unknown): boolean {
		const key = row.localId || row.id;
		if (!key) return false;
		const n = normalizeRecord(record);
		const prev = this.rows.get(key);
		// A durable row never gets replaced by a late live segment for the same key.
		if (prev?.seq !== undefined && row.seq === undefined) return false;

		if (row.seq !== undefined) {
			this.minSeq = this.minSeq === undefined ? row.seq : Math.min(this.minSeq, row.seq);
			this.maxSeq = this.maxSeq === undefined ? row.seq : Math.max(this.maxSeq, row.seq);
			if (n.usage && row.seq >= (this.usageSeq ?? 0)) {
				this.usage = { ...this.usage, ...dropUndefined(n.usage) };
				this.usageSeq = row.seq;
			}
		}
		for (const r of n.results) this.results.set(r.callId, r.result);
		if (n.failure && !this.failures.has(n.failure)) {
			this.failures.add(n.failure);
			this.ordered = null;
		}

		if (n.items.length === 0 && !prev) return n.results.length > 0;
		this.rows.set(key, { key, seq: row.seq, createdAt: prev?.createdAt ?? row.createdAt, items: n.items });
		this.ordered = null;
		return true;
	}
	private usageSeq: number | undefined;

	/** Appends text to a live stream segment (ephemeral delta). */
	appendDelta(key: string, text: string, baseLength: number): boolean {
		const row = this.rows.get(key);
		const item = row?.items[0];
		if (!row || row.seq !== undefined || !item || (item.kind !== "text" && item.kind !== "thinking")) return false;
		if (item.text.length !== baseLength) return false;
		item.text += text;
		this.version++;
		return true;
	}

	list(): Row[] {
		if (!this.ordered) {
			this.ordered = [...this.rows.values()]
				.filter((r) => r.items.length > 0)
				.sort((a, b) => {
					if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
					if (a.seq !== undefined) return -1;
					if (b.seq !== undefined) return 1;
					return a.createdAt - b.createdAt;
				});
		}
		return this.ordered;
	}
}

/** Claude SDK records of a subagent name the Task call they belong to. */
function claudeParentToolUseId(record: unknown): string | undefined {
	const content = isObj(record) && isObj(record.content) ? record.content : undefined;
	const data = content?.type === "output" && isObj(content.data) ? content.data : undefined;
	return str(data?.parent_tool_use_id) || undefined;
}

function dropUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
