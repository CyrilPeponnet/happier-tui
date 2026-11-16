import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Home, type HomeState, sortSessions } from "../src/ui/home.js";
import { session } from "./fixtures.js";

const sessions = sortSessions([
	session({ id: "a", activityAt: 30, metadata: { name: "api server", host: "alpha", flavor: "claude", path: "/srv/api" } }),
	session({ id: "b", activityAt: 20, metadata: { name: "docs site", host: "beta", flavor: "pi", path: "/srv/docs" } }),
	session({ id: "c", activityAt: 10, metadata: { name: "api client", host: "beta", flavor: "codex", path: "/srv/client" } }),
]);

function make(overrides: Partial<HomeState> = {}) {
	const opened: string[] = [];
	const state: HomeState = {
		sessions,
		hidden: 2,
		showInactive: false,
		hosts: [
			{ name: "alpha", online: true },
			{ name: "beta", online: true },
			{ name: "gamma", online: true },
		],
		hostOf: (s) => String(s.metadata.host),
		unread: new Set(),
		currentId: null,
		frame: 0,
		rows: 20,
		status: "status",
		...overrides,
	};
	const home = new Home(() => state);
	home.onOpen = (id) => opened.push(id);
	const text = () => home.render(100).map((l) => stripTerminalSequences(l).trimEnd());
	const selected = () => text().find((l) => l.trimStart().startsWith("›")) ?? "";
	return { home, opened, text, selected };
}

test("sessions needing an answer sort first, then live ones, then by recent activity", () => {
	const order = sortSessions([
		session({ id: "idle", active: false, activityAt: 99 }),
		session({ id: "old", activityAt: 1 }),
		session({ id: "new", activityAt: 2 }),
		session({ id: "asks", activityAt: 0, pendingPermissionRequestCount: 1 }),
	]).map((s) => s.id);
	assert.deepEqual(order, ["asks", "new", "old", "idle"]);
});

test("lists sessions under their host, and hosts without a session", () => {
	const { text, selected } = make();
	const lines = text().join("\n");
	assert.match(lines, /alpha ● online {2}1 session\n\s+› ● api server/);
	assert.match(lines, /beta ● online {2}2 sessions/);
	assert.match(lines, /gamma ● online\n\s+no active session/);
	assert.match(lines, /Show 2 inactive sessions/);
	assert.match(selected(), /api server/, "the first session is selected by default");
});

test("typing searches titles, hosts and paths, and enter opens the selection", () => {
	const { home, opened, text, selected } = make();
	for (const ch of "docs") home.handleInput(ch);
	const lines = text().join("\n");
	assert.match(lines, /docs site/);
	assert.doesNotMatch(lines, /api server|api client|gamma/);
	assert.match(selected(), /docs site/);
	home.handleInput("\r");
	assert.deepEqual(opened, ["b"]);
});

test("the selection moves with the arrow keys and escape clears the search first", () => {
	let back = 0;
	const { home, selected } = make();
	home.onBack = () => back++;
	home.handleInput("\x1b[B");
	assert.match(selected(), /docs site/);
	home.handleInput("x");
	home.handleInput("\x1b");
	assert.equal(back, 0, "first escape only clears the query");
	assert.match(selected(), /api server/);
	home.handleInput("\x1b");
	assert.equal(back, 1);
});

test("the open session is preselected when coming back to the list", () => {
	const { selected } = make({ currentId: "c" });
	assert.match(selected(), /api client.*◂ open/);
});
