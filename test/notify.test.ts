import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionChange, notificationSequence } from "../src/ui/notify.js";

const idle = { busy: false, requestIds: [], turnStatus: "completed" };
const busy = { busy: true, requestIds: [], turnStatus: "in_progress" };

const oscOnly = { osc: true, bell: false };

test("notification sequence is OSC 777 and cannot be broken out of by its content", () => {
	const seq = notificationSequence("a;b\x07\x1b]0;evil", "line1\nline2", oscOnly, {});
	assert.equal(seq, "\x1b]777;notify;a,b ]0,evil;line1 line2\x07");
	assert.equal(seq.split("\x07").length, 2, "exactly one terminator");
});

test("inside tmux the notification is wrapped for passthrough", () => {
	const seq = notificationSequence("t", "b", oscOnly, { TMUX: "/tmp/tmux-1/default,1,0" });
	assert.equal(seq, "\x1bPtmux;\x1b\x1b]777;notify;t;b\x07\x1b\\");
});

test("the bell is sent on its own channel and each signal can be turned off", () => {
	assert.equal(notificationSequence("t", "b", { osc: true, bell: true }, {}), "\x1b]777;notify;t;b\x07\x07");
	assert.equal(notificationSequence("t", "b", { osc: false, bell: true }, { TMUX: "x" }), "\x07");
	assert.equal(notificationSequence("t", "b", { osc: false, bell: false }, {}), "");
});

test("attention is raised for a new request and for a finished turn only", () => {
	assert.equal(attentionChange(undefined, busy), null, "first observation never notifies");
	assert.equal(attentionChange(idle, busy), null);
	assert.equal(attentionChange(busy, busy), null);
	assert.deepEqual(attentionChange(busy, idle), { kind: "finished", failed: false });
	assert.deepEqual(attentionChange(busy, { ...idle, turnStatus: "failed" }), { kind: "finished", failed: true });
	assert.deepEqual(attentionChange(busy, { ...busy, requestIds: ["r1"] }), { kind: "request", requestId: "r1" });
	assert.equal(attentionChange({ ...busy, requestIds: ["r1"] }, { ...busy, requestIds: ["r1"] }), null);
	// A turn that stops because it is waiting on a request is reported as the request, not as finished.
	assert.deepEqual(attentionChange(busy, { ...idle, requestIds: ["r2"] }), { kind: "request", requestId: "r2" });
});
