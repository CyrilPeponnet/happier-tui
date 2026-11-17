import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRecord, Transcript, toolResultText, toolSummary } from "../src/happier/transcript.js";

const acp = (data: object, meta: object = {}) => ({ role: "agent", content: { type: "acp", provider: "pi", data }, meta });

test("user record prefers displayText and hides tool-answer deliveries", () => {
	const n = normalizeRecord({ role: "user", content: { type: "text", text: "expanded" }, meta: { displayText: "typed" } });
	assert.deepEqual(n.items, [{ kind: "user", text: "typed", sentFrom: undefined }]);
	const hidden = normalizeRecord({
		role: "user",
		content: { type: "text", text: "x" },
		meta: { happier: { kind: "tool-answer-delivery.v1" } },
	});
	assert.equal(hidden.items.length, 0);
});

test("acp tool call and result are joined by callId", () => {
	const t = new Transcript();
	t.upsert({ id: "a", seq: 1, createdAt: 1 }, acp({ type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls -la" } }));
	t.upsert(
		{ id: "b", seq: 2, createdAt: 2 },
		acp({ type: "tool-result", callId: "c1", output: { content: [{ type: "text", text: "file.txt" }] }, isError: true }),
	);
	const rows = t.list();
	assert.equal(rows.length, 1);
	const item = rows[0]!.items[0]!;
	assert.equal(item.kind, "tool");
	if (item.kind !== "tool") return;
	assert.deepEqual(toolSummary(item), { name: "Bash", arg: "ls -la" });
	const result = t.results.get("c1");
	assert.equal(result?.isError, true);
	assert.equal(toolResultText(result?.output), "file.txt");
});

test("claude output record yields text, thinking, tool use and tool result", () => {
	const assistant = normalizeRecord({
		role: "agent",
		content: {
			type: "output",
			data: {
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "Hello" },
						{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
					],
				},
			},
		},
	});
	assert.deepEqual(
		assistant.items.map((i) => i.kind),
		["thinking", "text", "tool"],
	);
	const user = normalizeRecord({
		role: "agent",
		content: {
			type: "output",
			data: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
		},
	});
	assert.equal(user.items.length, 0);
	assert.deepEqual(user.results, [{ callId: "t1", result: { output: "ok", isError: false } }]);
});

test("a streamed segment is replaced by its durable row and ordered by seq", () => {
	const t = new Transcript();
	t.upsert({ id: "u", seq: 5, createdAt: 1 }, { role: "user", content: { type: "text", text: "hi" } });
	const streaming = { happierStreamSegmentV1: { segmentState: "streaming" } };
	t.upsert({ localId: "seg", createdAt: 2 }, acp({ type: "message", message: "Hel" }, streaming));
	assert.equal(t.appendDelta("seg", "lo", 3), true);
	assert.equal(t.appendDelta("seg", "!!", 99), false, "a delta with a gap is dropped");
	let last = t.list().at(-1)!.items[0]!;
	assert.deepEqual(last, { kind: "text", text: "Hello", streaming: true });

	t.upsert({ id: "m", localId: "seg", seq: 6, createdAt: 3 }, acp({ type: "message", message: "Hello there" }));
	assert.equal(t.list().length, 2);
	last = t.list().at(-1)!.items[0]!;
	assert.deepEqual(last, { kind: "text", text: "Hello there", streaming: false });
	// A late live snapshot must not overwrite the committed row.
	assert.equal(t.upsert({ localId: "seg", createdAt: 4 }, acp({ type: "message", message: "stale" }, streaming)), false);
	assert.equal(t.maxSeq, 6);
});

test("turn markers and token counts update usage without producing items", () => {
	const t = new Transcript();
	t.upsert({ id: "1", seq: 1, createdAt: 1 }, acp({ type: "task_started", id: "x" }));
	t.upsert(
		{ id: "2", seq: 2, createdAt: 2 },
		acp({ type: "token_count", tokens: { context_used_tokens: 10, context_window_tokens: 100 }, cost: { total: 0.5 } }),
	);
	t.upsert({ id: "3", seq: 3, createdAt: 3 }, { role: "agent", content: { type: "event", id: "e", data: { type: "ready" } } });
	assert.equal(t.list().length, 0);
	assert.deepEqual(t.usage, { contextUsed: 10, contextWindow: 100, cost: 0.5 });
});

test("malformed records are ignored", () => {
	for (const bad of [null, "x", {}, { role: "agent" }, { role: "agent", content: { type: "acp" } }]) {
		assert.deepEqual(normalizeRecord(bad).items, []);
	}
});

test("provider terminal output that repeats the turn failure is recorded once", () => {
	const t = new Transcript();
	const text = "provider failure: Connection error.";
	t.upsert({ id: "1", seq: 1, createdAt: 1 }, acp({ type: "tool-call", callId: "c", name: "terminal-output", input: {} }));
	t.upsert({ id: "2", seq: 2, createdAt: 2 }, acp({ type: "tool-result", callId: "c", output: { value: text }, isError: true }));
	assert.equal(toolResultText(t.results.get("c")?.output), text);
	assert.equal(t.failures.has(text), false);
	t.upsert({ id: "3", seq: 3, createdAt: 3 }, acp({ type: "turn_failed", id: "x", issue: { sanitizedPreview: text } }));
	assert.equal(t.failures.has(text), true);
	assert.deepEqual(t.list().at(-1)!.items, [{ kind: "notice", text: `Turn failed: ${text}`, level: "error" }]);
});
const claudeResult = (toolUseResult: object, content = "model text") => ({ content, tool_use_result: toolUseResult });

test("claude tool results read as text: diffs, read counts, command output", () => {
	const edit = claudeResult({
		filePath: "/a",
		structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-old", "+new"] }],
	});
	assert.equal(toolResultText(edit), "@@ -3,1 +3,1 @@\n-old\n+new");
	assert.equal(toolResultText(claudeResult({ type: "text", file: { numLines: 12 } })), "Read 12 lines");
	assert.equal(toolResultText(claudeResult({ stdout: "out", stderr: "err", interrupted: false })), "out\nerr");
	assert.equal(toolResultText(claudeResult({ matches: [] }, "fallback")), "fallback");
	// JSON returned as text by MCP tools, and leftover objects, become key: value lines.
	assert.equal(toolResultText([{ type: "text", text: '{"success":true,"title":"T"}' }]), "success: true\ntitle: T");
	assert.equal(toolResultText({ status: "completed" }), "status: completed");
});

test("subagent records go to their own transcript, not the main one", () => {
	const t = new Transcript();
	const sub = { role: "agent", content: { type: "output", data: { type: "assistant", message: { content: [{ type: "text", text: "sub" }] } } } };
	t.upsert({ id: "a", seq: 1, createdAt: 1, sidechainId: "call1" }, sub);
	// Claude records name their parent tool call even without the relay's sidechain column.
	const viaParent = { role: "agent", content: { type: "output", data: { type: "assistant", parent_tool_use_id: "call2", message: { content: [{ type: "text", text: "x" }] } } } };
	t.upsert({ id: "b", seq: 2, createdAt: 2 }, viaParent);
	assert.equal(t.list().length, 0);
	assert.equal(t.sidechains.get("call1")?.list().length, 1);
	assert.equal(t.sidechains.get("call2")?.list().length, 1);
	assert.equal(t.sidechains.get("call2")?.sidechains.size, 0);
});
