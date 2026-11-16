import type { Session } from "../src/happier/client.js";

/** A decrypted session row with sensible defaults, for tests. */
export function session(overrides: Partial<Session> & { id: string }): Session {
	return {
		seq: 1,
		createdAt: 0,
		updatedAt: 0,
		activityAt: 0,
		active: true,
		activeAt: 0,
		archivedAt: null,
		encryptionMode: "e2ee",
		key: null,
		metadata: {},
		metadataVersion: 1,
		agentState: null,
		agentStateVersion: 0,
		thinking: false,
		latestTurnStatus: null,
		pendingCount: 0,
		pendingPermissionRequestCount: 0,
		pendingUserActionRequestCount: 0,
		...overrides,
	};
}
