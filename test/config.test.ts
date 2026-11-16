import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/happier/config.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

function home(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "happier-home-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), JSON.stringify(content));
	}
	return dir;
}

test("defaults to the cloud server and reads data-key credentials", () => {
	const dir = home({ "servers/cloud/access.key": { token: "t", encryption: { publicKey: KEY, machineKey: KEY } } });
	const cfg = loadConfig({ homeDir: dir });
	assert.equal(cfg.serverId, "cloud");
	assert.equal(cfg.serverUrl, "https://api.happier.dev");
	assert.equal(cfg.token, "t");
	assert.equal(cfg.keys.type, "dataKey");
});

test("uses the active server profile, selectable by id or name, and strips trailing slashes", () => {
	const dir = home({
		"settings.json": {
			schemaVersion: 6,
			activeServerId: "home",
			servers: {
				home: { name: "Home lab", serverUrl: "https://relay.example/", localServerUrl: "http://10.0.0.2:3005/" },
				work: { name: "Work", serverUrl: "https://work.example" },
			},
		},
		"servers/home/access.key": { token: "h", secret: KEY },
		"servers/work/access.key": { token: "w", encryption: null },
	});
	const active = loadConfig({ homeDir: dir });
	assert.equal(active.serverUrl, "http://10.0.0.2:3005");
	assert.equal(active.keys.type, "legacy");

	const byName = loadConfig({ homeDir: dir, serverId: "Work" });
	assert.equal(byName.serverId, "work");
	assert.equal(byName.serverUrl, "https://work.example");
	assert.equal(byName.keys.type, "tokenOnly");

	assert.equal(loadConfig({ homeDir: dir, serverUrl: "http://localhost:1/" }).serverUrl, "http://localhost:1");
});

test("explains what to do when credentials or the server are missing", () => {
	assert.throws(() => loadConfig({ homeDir: home({}) }), /happier auth login/);
	const dir = home({ "servers/cloud/access.key": { token: "t" } });
	assert.throws(() => loadConfig({ homeDir: dir, serverId: "nope" }), /Unknown Happier server "nope"/);
});
