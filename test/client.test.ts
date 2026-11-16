import assert from "node:assert/strict";
import { test } from "node:test";
import { isBusy, pendingRequests, sessionModels, sessionTitle } from "../src/happier/client.js";
import { session } from "./fixtures.js";

test("session title prefers the summary, then the name, then the directory", () => {
	const path = "/home/me/projects/api";
	assert.equal(sessionTitle(session({ id: "s", metadata: { summary: { text: "Fix login" }, name: "n", path } })), "Fix login");
	assert.equal(sessionTitle(session({ id: "s", metadata: { summary: { text: "  " }, name: "n", path } })), "n");
	assert.equal(sessionTitle(session({ id: "s", metadata: { path } })), "api");
	assert.equal(sessionTitle(session({ id: "s" })), "s");
});

test("a session is busy only while active with a turn in progress", () => {
	assert.equal(isBusy(session({ id: "s", latestTurnStatus: "in_progress" })), true);
	assert.equal(isBusy(session({ id: "s", thinking: true })), true);
	assert.equal(isBusy(session({ id: "s", latestTurnStatus: "completed" })), false);
	assert.equal(isBusy(session({ id: "s", active: false, latestTurnStatus: "in_progress" })), false);
});

test("pending requests come from agent state, oldest first", () => {
	const s = session({
		id: "s",
		agentState: {
			requests: {
				b: { tool: "Bash", arguments: { command: "ls" }, createdAt: 2, occurrenceId: "o" },
				a: { tool: "Edit", kind: "permission", arguments: {}, createdAt: 1 },
				junk: "not a request",
			},
		},
	});
	assert.deepEqual(
		pendingRequests(s).map((r) => [r.id, r.tool, r.occurrenceId]),
		[
			["a", "Edit", undefined],
			["b", "Bash", "o"],
		],
	);
	assert.deepEqual(pendingRequests(session({ id: "s" })), []);
});

test("the model in effect is the override, then the applied one, then the reported one", () => {
	const list = { currentModelId: "m-reported", availableModels: [{ id: "m1", name: "One" }, { id: "m2" }, { id: "m1" }] };
	const reported = session({ id: "s", metadata: { sessionModelsV1: list, acpSessionModelsV1: list } });
	assert.equal(sessionModels(reported).current, "m-reported");
	assert.deepEqual(
		sessionModels(reported).available.map((m) => [m.id, m.name]),
		[
			["m1", "One"],
			["m2", "m2"],
		],
	);
	const applied = session({ id: "s", metadata: { sessionModelsV1: list, sessionAppliedModelV1: { modelId: "m-applied" } } });
	assert.equal(sessionModels(applied).current, "m-applied");
	const override = session({ id: "s", metadata: { ...applied.metadata, modelOverrideV1: { modelId: "m-override" } } });
	assert.equal(sessionModels(override).current, "m-override");
	assert.deepEqual(sessionModels(session({ id: "s" })), { current: "", available: [] });
});
