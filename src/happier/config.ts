/**
 * Reads the server profile and credentials the Happier CLI already stored
 * (`happier auth login`), so the TUI needs no login flow of its own.
 * Mirrors apps/cli/src/configuration.ts and apps/cli/src/persistence.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b64decode } from "./crypto.js";

export type AccountKeys =
	/** Legacy accounts: one 32-byte secret, secretbox for everything. */
	| { type: "legacy"; secret: Uint8Array }
	/** Current accounts: X25519 content key pair; content uses per-record data keys. */
	| { type: "dataKey"; publicKey: Uint8Array; machineKey: Uint8Array }
	/** Keyless account: only plaintext-storage sessions are readable. */
	| { type: "tokenOnly" };

export interface HappierConfig {
	homeDir: string;
	serverId: string;
	serverName: string;
	serverUrl: string;
	token: string;
	keys: AccountKeys;
}

export interface ConfigOverrides {
	homeDir?: string;
	serverId?: string;
	serverUrl?: string;
}

interface ServerProfile {
	id?: string;
	name?: string;
	serverUrl?: string;
	localServerUrl?: string;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function loadConfig(overrides: ConfigOverrides = {}): HappierConfig {
	const env = process.env;
	const homeDir = overrides.homeDir ?? env.HAPPIER_HOME_DIR ?? join(homedir(), ".happier");

	let serverId = "cloud";
	let serverName = "Happier Cloud";
	let serverUrl = "https://api.happier.dev";

	const settingsPath = join(homeDir, "settings.json");
	let profiles: Record<string, ServerProfile> = {};
	if (existsSync(settingsPath)) {
		const settings = readJson(settingsPath) as {
			schemaVersion?: number;
			activeServerId?: string;
			servers?: Record<string, ServerProfile>;
		};
		if ((settings.schemaVersion ?? 0) >= 5) {
			profiles = settings.servers ?? {};
			if (settings.activeServerId) serverId = settings.activeServerId;
		}
	}

	serverId = overrides.serverId ?? env.HAPPIER_ACTIVE_SERVER_ID ?? serverId;
	// Allow selecting a profile by display name as well as by id, like `happier --server`.
	const byName = Object.entries(profiles).find(([, p]) => p.name === serverId);
	if (!profiles[serverId] && byName) serverId = byName[0];

	const profile = profiles[serverId];
	if (profile) {
		serverName = profile.name ?? serverId;
		serverUrl = profile.localServerUrl || profile.serverUrl || serverUrl;
	} else if (serverId !== "cloud") {
		const known = Object.keys(profiles).join(", ") || "(none)";
		throw new Error(`Unknown Happier server "${serverId}". Known servers: ${known}`);
	}
	serverUrl = (overrides.serverUrl ?? env.HAPPIER_LOCAL_SERVER_URL ?? env.HAPPIER_SERVER_URL ?? serverUrl).replace(
		/\/+$/,
		"",
	);

	const perServer = join(homeDir, "servers", serverId, "access.key");
	const legacyPath = join(homeDir, "access.key");
	const keyPath = existsSync(perServer) ? perServer : serverId === "cloud" && existsSync(legacyPath) ? legacyPath : null;
	if (!keyPath) {
		throw new Error(
			`No Happier credentials found for server "${serverId}" (${perServer}).\nRun \`happier auth login\` first.`,
		);
	}

	const raw = readJson(keyPath) as {
		token?: string;
		secret?: string | null;
		encryption?: { publicKey?: string; machineKey?: string } | null;
	};
	if (!raw.token) throw new Error(`Credentials file ${keyPath} has no token. Run \`happier auth login\`.`);

	let keys: AccountKeys;
	if (raw.secret) {
		keys = { type: "legacy", secret: b64decode(raw.secret) };
	} else if (raw.encryption?.publicKey && raw.encryption.machineKey) {
		keys = {
			type: "dataKey",
			publicKey: b64decode(raw.encryption.publicKey),
			machineKey: b64decode(raw.encryption.machineKey),
		};
	} else {
		keys = { type: "tokenOnly" };
	}

	return { homeDir, serverId, serverName, serverUrl, token: raw.token, keys };
}
