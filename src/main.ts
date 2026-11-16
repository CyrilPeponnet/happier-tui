#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "./app.js";
import { HappierClient, isBusy, sessionTitle } from "./happier/client.js";
import { type ConfigOverrides, loadConfig } from "./happier/config.js";
import { sortSessions } from "./ui/home.js";
import { ago } from "./ui/theme.js";

const USAGE = `happier-tui — terminal client for your Happier agent sessions

Usage
  happier-tui [session-id-or-prefix]   Open the TUI (optionally on a given session)
  happier-tui <directory>              Start a new session on this machine in that directory
  happier-tui --list [--all]           Print active sessions (all with --all) and exit

Options
  --server <id-or-name>   Use a server profile from ~/.happier/settings.json
  --server-url <url>      Override the relay URL
  --home <dir>            Happier home directory (default ~/.happier, or $HAPPIER_HOME_DIR)
  --agent <name>          Agent for the new session (claude, codex, pi, …); asked for otherwise
  --no-notify             No attention signal at all when an agent needs you
  --no-bell               Keep the text notification but do not ring the terminal bell
  -h, --help              Show this help

Credentials come from the Happier CLI: run \`happier auth login\` once on this machine.`;

/** A positional argument is a directory when it looks like a path or names an existing folder. */
function isDirectoryArg(arg: string): boolean {
	const isDir = existsSync(arg) && statSync(arg).isDirectory();
	if (arg === "." || arg === ".." || arg.includes("/")) {
		if (!isDir) throw new Error(`Not a directory: ${arg}`);
		return true;
	}
	return isDir;
}

function parseArgs(argv: string[]) {
	const overrides: ConfigOverrides = {};
	let list = false;
	const notify = { osc: true, bell: true };
	let all = false;
	let session: string | undefined;
	let directory: string | undefined;
	let agent: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const value = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value for ${a}`);
			return v;
		};
		if (a === "-h" || a === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else if (a === "--list") list = true;
		else if (a === "--all") all = true;
		else if (a === "--no-notify") notify.osc = notify.bell = false;
		else if (a === "--no-bell") notify.bell = false;
		else if (a === "--agent") agent = value();
		else if (a === "--server") overrides.serverId = value();
		else if (a === "--server-url") overrides.serverUrl = value();
		else if (a === "--home") overrides.homeDir = value();
		else if (a.startsWith("-")) throw new Error(`Unknown option ${a}\n\n${USAGE}`);
		else if (isDirectoryArg(a)) directory = resolve(a);
		else session = a;
	}
	if (agent && !directory) throw new Error("--agent needs a directory to start the session in, e.g. `happier-tui . --agent claude`.");
	return { overrides, list, session, notify, all, launch: directory ? { directory, agent } : undefined };
}

async function main(): Promise<void> {
	const { overrides, list, session, notify, all, launch } = parseArgs(process.argv.slice(2));
	const client = new HappierClient(loadConfig(overrides));

	if (list) {
		const [sessions] = await Promise.all([client.refreshSessions(), client.refreshMachines().catch(() => [])]);
		for (const s of sortSessions(sessions).filter((x) => all || x.active)) {
			const state = isBusy(s) ? "busy" : s.active ? "live" : "idle";
			const host = String(s.metadata.host ?? "?").split(".")[0];
			console.log(
				[s.id, state.padEnd(4), String(s.metadata.flavor ?? "?").padEnd(8), ago(s.activityAt).padEnd(4), host, sessionTitle(s)].join("  "),
			);
		}
		return;
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("happier-tui needs an interactive terminal (use --list for scripting).");
	}
	const app = new App(client, session, notify, launch);
	await app.start();
	await app.done;
	process.exit(0);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
