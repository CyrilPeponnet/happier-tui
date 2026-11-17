import assert from "node:assert/strict";
import { test } from "node:test";
import {
	effortOverride,
	isWaitingForLimit,
	sessionGoal,
	sessionModes,
	sessionOptions,
	usageLimit,
	withConfigOverride,
	withModeOverride,
} from "../src/happier/controls.js";

const effortOption = {
	id: "reasoning_effort",
	name: "Thinking",
	type: "select",
	currentValue: "medium",
	options: [
		{ value: "low", name: "Low" },
		{ value: "high", name: "High" },
	],
};
const models = { v: 1, updatedAt: 1, currentModelId: "m1", availableModels: [{ id: "m1", name: "M1", modelOptions: [effortOption] }, { id: "m2" }] };

test("options come from the model in effect, and a user override wins", () => {
	const m = { sessionModelsV1: models };
	assert.deepEqual(sessionOptions(m, "m2"), []);
	const [effort] = sessionOptions(m, "m1");
	assert.equal(effort?.id, "reasoning_effort");
	assert.equal(effort?.current, "medium");
	assert.deepEqual(effort?.choices.map((c) => c.value), ["low", "high"]);

	const next = withConfigOverride(m, "reasoning_effort", "high");
	assert.equal(sessionOptions(next, "m1")[0]?.current, "high");
	assert.equal(effortOverride(next), "high");
	// Written under both keys, as the Happier app does, and merged with other overrides.
	assert.deepEqual(next.sessionConfigOptionOverridesV1, next.acpConfigOptionOverridesV1);
	const both = withConfigOverride(next, "ultracode", "true") as { sessionConfigOptionOverridesV1: { overrides: object } };
	assert.deepEqual(Object.keys(both.sessionConfigOptionOverridesV1.overrides).sort(), ["reasoning_effort", "ultracode"]);
});

test("an override write is always newer than what is stored", () => {
	const future = Date.now() + 60_000;
	const m = { sessionConfigOptionOverridesV1: { v: 1, updatedAt: future, overrides: {} } };
	const next = withConfigOverride(m, "reasoning_effort", "low") as { sessionConfigOptionOverridesV1: { updatedAt: number } };
	assert.ok(next.sessionConfigOptionOverridesV1.updatedAt > future);
});

test("agent modes: reported list, override in effect", () => {
	const m = {
		acpSessionModesV1: { v: 1, updatedAt: 1, currentModeId: "code", availableModes: [{ id: "code", name: "Code" }, { id: "ask", name: "Ask" }] },
	};
	assert.equal(sessionModes(m).current, "code");
	assert.deepEqual(sessionModes(m).available.map((x) => x.value), ["code", "ask"]);
	const next = withModeOverride(m, "ask");
	assert.equal(sessionModes(next).current, "ask");
	assert.deepEqual(next.sessionModeOverrideV1, next.acpSessionModeOverrideV1);
	assert.deepEqual(sessionModes({}).available, []);
});

test("goal is the primary goal item of the work state", () => {
	assert.equal(sessionGoal({}), null);
	const m = {
		sessionWorkStateV1: {
			v: 1,
			primaryItemId: "g2",
			items: [
				{ id: "t", kind: "task", title: "task" },
				{ id: "g1", kind: "goal", title: "old", status: "complete" },
				{ id: "g2", kind: "goal", title: "Ship it", status: "blocked", statusReason: "usageLimited" },
			],
		},
	};
	assert.deepEqual(sessionGoal(m), { title: "Ship it", status: "blocked", reason: "usageLimited" });
});

test("usage-limit recovery state", () => {
	assert.equal(usageLimit({}), null);
	assert.equal(usageLimit({ sessionUsageLimitRecoveryV1: { status: "cancelled" } }), null);
	const u = usageLimit({ sessionUsageLimitRecoveryV1: { status: "waiting", resetAtMs: 5, issueFingerprint: "f", armedAtMs: 1 } });
	assert.equal(u?.resetAt, 5);
	assert.ok(isWaitingForLimit(u));
	assert.ok(!isWaitingForLimit(usageLimit({ sessionUsageLimitRecoveryV1: { status: "exhausted" } })));
});
