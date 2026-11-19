import { spawn, spawnSync } from "node:child_process";

/**
 * Tab restore in cmux. cmux reopens an agent tab after a restart only when the agent's own hook
 * registered it, and has no hook for custom tools, so happier-tui reports itself through pi's:
 * cmux then stores `happier-tui --session <id>` as the tab's restore command (the tab shows as
 * Pi). The entry follows the open session and is cleared on a normal quit. Outside cmux, or when
 * the cmux command fails, nothing happens.
 */

const surface = process.env.CMUX_SURFACE_ID;
const cmux = process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
let bound: string | undefined;

function run(args: string[], input?: string): void {
	try {
		const child = spawn(cmux, args, { stdio: [input ? "pipe" : "ignore", "ignore", "ignore"], env: hookEnv() });
		child.on("error", () => {});
		child.stdin?.end(input);
		child.unref();
	} catch {
		// cmux integration is best effort
	}
}

function hookEnv(): NodeJS.ProcessEnv {
	// The restore command is rebuilt from this executable; extra arguments are not kept by cmux.
	const exe = process.argv[1] ?? "happier-tui";
	return {
		...process.env,
		CMUX_AGENT_LAUNCH_KIND: "pi",
		CMUX_AGENT_LAUNCH_EXECUTABLE: exe,
		CMUX_AGENT_LAUNCH_ARGV_B64: Buffer.from(`${exe}\0`).toString("base64"),
		CMUX_AGENT_LAUNCH_CWD: process.cwd(),
	};
}

/** Makes `sessionId` the session this cmux tab reopens. */
export function cmuxBind(sessionId: string): void {
	if (!surface || sessionId === bound) return;
	bound = sessionId;
	const event = "SessionStart";
	run(
		["hooks", "pi", "session-start", "--surface", surface],
		JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, event }),
	);
}

/** Forgets the restore entry, so a tab closed on purpose does not come back. */
export function cmuxUnbind(): void {
	if (!surface || !bound) return;
	try {
		spawnSync(cmux, ["surface", "resume", "clear", "--surface", surface, "--checkpoint-id", bound, "--source", "agent-hook"], {
			stdio: "ignore",
			timeout: 2000,
		});
	} catch {
		// best effort
	}
	bound = undefined;
}
