import assert from "node:assert/strict";
import { test } from "node:test";
import nacl from "tweetnacl";
import { createHmac } from "node:crypto";
import { openAccountScoped } from "../src/happier/crypto.js";
import { planLimits } from "../src/happier/usage.js";

const now = 1_000_000_000_000;
const meter = (o: Record<string, unknown>) => ({ unit: "unknown", status: "ok", used: null, limit: null, details: { limitCategory: "usage_limit" }, ...o });
const record = (meters: unknown[], o: Record<string, unknown> = {}) => ({ providerId: "claude", state: "loaded_data", fetchedAtMs: now - 60_000, meters, ...o });

test("plan limits: usage limits of the newest record, shortest window first", () => {
	const older = record([meter({ meterId: "five_hour", label: "5-hour", utilizationPct: 10 })], { fetchedAtMs: now - 600_000 });
	const newer = record([
		meter({ meterId: "seven_day", label: "Weekly", utilizationPct: 6, resetAtMs: now + 3 * 86_400_000 }),
		meter({ meterId: "five_hour", label: "5-hour", utilizationPct: 53, resetAtMs: now + 3_600_000 }),
		meter({ meterId: "extra_usage", label: "Extra usage", unit: "credits", utilizationPct: null, details: {} }),
	]);
	const limits = planLimits([older, newer], "claude", undefined, now);
	assert.deepEqual(
		limits.map((l) => [l.short, l.label, l.usedPct, l.resetAt]),
		[
			["5h", "5-hour", 53, now + 3_600_000],
			["wk", "Weekly", 6, now + 3 * 86_400_000],
		],
	);
});

test("plan limits: other providers, model limits of other models and reset windows", () => {
	const r = record([
		meter({ meterId: "five_hour", label: "5-hour", remainingPct: 20, resetAtMs: now - 1 }),
		meter({ meterId: "weekly_opus", label: "Weekly (Opus)", modelId: "opus", utilizationPct: 70, windowDurationMs: 7 * 86_400_000 }),
	]);
	assert.deepEqual(planLimits([r], "codex", undefined, now), []);
	assert.deepEqual(planLimits([r], "claude", "sonnet-4.5", now).map((l) => [l.short, l.usedPct]), [["5h", 0]]);
	assert.deepEqual(planLimits([r], "claude", "opus-4.5", now).map((l) => [l.short, l.usedPct]), [["5h", 0], ["wk", 70]]);
});

test("account-scoped blobs open with the key derived for their kind", () => {
	const machineKey = new Uint8Array(32).fill(7);
	const key = new Uint8Array(createHmac("sha512", machineKey).update("happier:account_scoped:provider_account_usage_snapshot:v1").digest()).slice(0, 32);
	const nonce = new Uint8Array(24).fill(1);
	const boxed = nacl.secretbox(new TextEncoder().encode(JSON.stringify({ v: 1, meters: [] })), nonce, key);
	const blob = Buffer.from([0xa1, 6, ...nonce, ...boxed]).toString("base64");
	assert.deepEqual(openAccountScoped(machineKey, "provider_account_usage_snapshot", blob), { v: 1, meters: [] });
	assert.equal(openAccountScoped(new Uint8Array(32), "provider_account_usage_snapshot", blob), null);
	assert.equal(openAccountScoped(machineKey, "provider_account_usage_snapshot", Buffer.from([0xa1, 4, ...nonce, ...boxed]).toString("base64")), null);
});
