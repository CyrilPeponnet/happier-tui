import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { latestOptions, splitOptions, Transcript, toolSummary } from "../src/happier/transcript.js";
import { formatDuration, TranscriptView } from "../src/ui/transcript-view.js";

const user = (text: string) => ({ role: "user", content: { type: "text", text } });
const acp = (data: object) => ({ role: "agent", content: { type: "acp", provider: "pi", data } });
const plain = (lines: string[]) => lines.map((l) => stripTerminalSequences(l).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

function transcript(): Transcript {
	const t = new Transcript();
	t.upsert({ id: "1", seq: 1, createdAt: 0 }, user("fix it"));
	t.upsert({ id: "2", seq: 2, createdAt: 1000 }, acp({ type: "tool-call", callId: "a", name: "Read", input: { file_path: "a.ts" } }));
	t.upsert({ id: "3", seq: 3, createdAt: 2000 }, acp({ type: "tool-call", callId: "b", name: "Bash", input: { command: "npm test" } }));
	t.upsert({ id: "4", seq: 4, createdAt: 3000 }, acp({ type: "tool-result", callId: "b", output: "ok" }));
	t.upsert({ id: "5", seq: 5, createdAt: 65_000 }, acp({ type: "message", message: "Done." }));
	return t;
}

test("a finished turn folds its tool calls and ends with a summary", () => {
	const view = new TranscriptView();
	view.setTranscript(transcript());
	const text = plain(view.render(100));
	assert.match(text, /▸ 2 tools · Read · Bash/);
	assert.doesNotMatch(text, /npm test/);
	assert.match(text, /✓ 1m 5s · 2 tools/);
});

test("a turn in progress, or expanded output, shows every tool", () => {
	const view = new TranscriptView();
	view.setTranscript(transcript());
	view.isBusy = () => true;
	const busy = plain(view.render(100));
	assert.match(busy, /Bash npm test/);
	assert.doesNotMatch(busy, /✓/);
	view.isBusy = () => false;
	view.options.expandTools = true;
	assert.match(plain(view.render(100)), /Bash npm test/);
});

test("a step is named by the agent's description, with the command as detail", () => {
	const item = { kind: "tool" as const, callId: "x", name: "Bash", input: { command: "ls -la", description: "List files" }, description: "List files" };
	assert.deepEqual(toolSummary(item), { name: "Bash", arg: "List files", detail: "ls -la" });
	assert.deepEqual(toolSummary({ ...item, description: undefined }), { name: "Bash", arg: "ls -la" });
});

test("durations", () => {
	assert.equal(formatDuration(4_200), "4s");
	assert.equal(formatDuration(134_000), "2m 14s");
	assert.equal(formatDuration(3_900_000), "1h 5m");
});

test("clicking a folded run unfolds it, and its ▾ line folds it back", () => {
	const view = new TranscriptView();
	view.setTranscript(transcript());
	const click = (text: string) => {
		const y = plain(view.render(100)).split("\n").findIndex((l) => l.includes(text));
		assert.ok(y >= 0, `no line with ${text}`);
		const base = { button: "left" as const, x: 2, y, screenX: 2, screenY: y, width: 100, height: 40, shift: false, alt: false, ctrl: false };
		assert.equal(view.handleMouse({ ...base, type: "press" })?.handled, true);
		assert.equal(view.handleMouse({ ...base, type: "click" })?.render, true);
	};
	click("▸ 2 tools");
	assert.match(plain(view.render(100)), /▾ 2 tools[\s\S]*Bash npm test/);
	click("▾ 2 tools");
	assert.match(plain(view.render(100)), /▸ 2 tools/);
	// Lines that are not clickable are left to text selection.
	const base = { button: "left" as const, x: 2, y: 0, screenX: 2, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false };
	assert.equal(view.handleMouse({ ...base, type: "press" }), undefined);
});

test("offered options render as lines that send themselves when clicked", () => {
	const t = new Transcript();
	t.upsert({ id: "1", seq: 1, createdAt: 0 }, user("what next?"));
	t.upsert(
		{ id: "2", seq: 2, createdAt: 1 },
		acp({ type: "message", message: "Pick one:\n<options><option>Ship it</option><option>Write tests</option></options>" }),
	);
	assert.deepEqual(latestOptions(t), { key: "2", options: ["Ship it", "Write tests"] });
	// Later records without choices (usage, turn end) do not make it a new offer.
	t.upsert({ id: "2b", seq: 4, createdAt: 1 }, acp({ type: "message", message: "" }));
	assert.equal(latestOptions(t)?.key, "2");
	const view = new TranscriptView();
	view.setTranscript(t);
	const sent: string[] = [];
	view.onOption = (o) => sent.push(o);
	const lines = plain(view.render(80)).split("\n");
	assert.ok(!lines.some((l) => l.includes("<option>")));
	const y = lines.findIndex((l) => l.includes("❯ Write tests"));
	const base = { button: "left" as const, x: 2, y, screenX: 2, screenY: y, width: 80, height: 40, shift: false, alt: false, ctrl: false };
	view.handleMouse({ ...base, type: "press" });
	view.handleMouse({ ...base, type: "click" });
	assert.deepEqual(sent, ["Write tests"]);
	// Once the user replied, the choices are no longer the latest ones.
	t.upsert({ id: "3", seq: 3, createdAt: 2 }, user("Write tests"));
	assert.equal(latestOptions(t), undefined);
});

test("options are split out of the text", () => {
	assert.deepEqual(splitOptions("A\n<options><option> x </option><option></option></options>"), { text: "A", options: ["x"] });
	assert.deepEqual(splitOptions("partial <options><option>x"), { text: "partial <options><option>x", options: [] });
});

test("code blocks lose their fences: the language stays as a label, the tag never shows", () => {
	const t = new Transcript();
	t.upsert({ id: "1", seq: 1, createdAt: 0 }, acp({ type: "message", message: "Like this:\n\n```python\nif x:\n    pass\n```\n\nDone." }));
	const view = new TranscriptView();
	view.setTranscript(t);
	const lines = view.render(60);
	assert.ok(lines.every((l) => !l.includes("happier:fence")));
	const text = plain(lines);
	assert.doesNotMatch(text, /```/);
	assert.match(text, /^ {3}python *\n {3}if x: *\n {7}pass *\n/m);
});
