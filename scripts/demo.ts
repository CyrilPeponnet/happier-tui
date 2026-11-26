/**
 * The real TUI on made-up sessions, for screenshots (`npm run screenshots`) and for trying the UI
 * without an account: `npx tsx scripts/demo.ts`. Nothing touches the network.
 */
import { App } from "../src/app.js";
import {
	HappierClient,
	type Machine,
	type MessagePage,
	type MessageRow,
	type PermissionRequest,
	type Session,
} from "../src/happier/client.js";
import type { HappierConfig } from "../src/happier/config.js";

const now = Date.now();
const min = 60_000;
const HOME = "/home/dev";

// --- machines ----------------------------------------------------------------

const machine = (id: string, host: string, active = true): Machine => ({
	id,
	active,
	activeAt: now,
	key: null,
	metadata: { host, displayName: host },
	daemonState: null,
});

const MACHINES = [machine("m-studio", "studio"), machine("m-build", "build-01"), machine("m-gpu", "gpu-box"), machine("m-nas", "nas", false)];

// --- transcript records ------------------------------------------------------

type Rec = Record<string, unknown>;
const user = (text: string): Rec => ({ role: "user", content: { type: "text", text } });
const agent = (data: Rec): Rec => ({ role: "agent", content: { type: "acp", provider: "claude", data } });
const say = (message: string) => agent({ type: "message", message });
const think = (text: string) => agent({ type: "thinking", text });
const call = (callId: string, name: string, input: Rec) => agent({ type: "tool-call", callId, name, input });
const result = (callId: string, output: unknown) => agent({ type: "tool-result", callId, output });

const RATE_LIMIT_DIFF = `@@ -0,0 +1,14 @@
+export class TokenBucket {
+  private tokens: number;
+  private last = Date.now();
+
+  constructor(private readonly rate: number, private readonly burst: number) {
+    this.tokens = burst;
+  }
+
+  take(): boolean {
+    const elapsed = (Date.now() - this.last) / 1000;
+    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
+    this.last = Date.now();
+    return this.tokens >= 1 ? (this.tokens--, true) : false;
+  }`;

const CI_DIFF = `@@ -4,9 +4,9 @@ jobs:
   build:
-    runs-on: ubuntu-latest
+    runs-on: ubuntu-24.04-arm
     steps:
       - uses: actions/checkout@v4
       - uses: actions/cache@v4
         with:
           path: node_modules
-          key: deps-\${{ hashFiles('package-lock.json') }}
+          key: deps-\${{ runner.arch }}-\${{ hashFiles('package-lock.json') }}`;

const TRANSCRIPTS: Record<string, Rec[]> = {
	gateway: [
		user("Add per-client rate limiting to the API gateway. Use a token bucket and make the limits configurable."),
		think("The gateway has a middleware chain; a limiter keyed on the API key fits there, with limits read from config."),
		call("t1", "Grep", { pattern: "app.use\\(", path: "src/gateway" }),
		result("t1", "src/gateway/server.ts:18:  app.use(auth());\nsrc/gateway/server.ts:19:  app.use(routes());"),
		call("t2", "Read", { file_path: "src/gateway/server.ts" }),
		result("t2", "import { auth } from './auth';\n…"),
		call("t3", "Edit", { file_path: "src/gateway/ratelimit.ts" }),
		result("t3", { diff: RATE_LIMIT_DIFF }),
		call("t4", "Bash", { command: "npm test -- ratelimit" }),
		result("t4", "✓ token bucket refills over time\n✓ bursts up to the limit\n✓ 429 with Retry-After when empty\n\n3 passed (412ms)"),
		say(
			[
				"## Rate limiting is in",
				"",
				"Each API key gets its own **token bucket**, checked right after authentication:",
				"",
				"- `rate` and `burst` come from `gateway.rateLimit` in the config",
				"- an empty bucket answers `429` with a `Retry-After` header",
				"",
				"```ts",
				"app.use(auth());",
				"app.use(rateLimit({ rate: 10, burst: 20 })); // per API key",
				"app.use(routes());",
				"```",
				"",
				"All 3 new tests pass. What next?",
				"<options><option>Add per-route overrides</option><option>Export metrics for rejected requests</option><option>Open a pull request</option></options>",
			].join("\n"),
		),
		agent({ type: "token_count", tokens: { context_used_tokens: 41_200, context_window_tokens: 200_000 } }),
	],
	ci: [
		user("Move the CI pipeline to the new arm64 runners and keep the cache working."),
		think("The cache key has no architecture in it, so arm64 jobs would restore x64 node_modules."),
		call("c1", "Read", { file_path: ".github/workflows/ci.yml" }),
		result("c1", "name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n…"),
		call("c2", "Edit", { file_path: ".github/workflows/ci.yml" }),
		result("c2", { diff: CI_DIFF }),
		call("c3", "Bash", { command: "act -j build --container-architecture linux/arm64" }),
	],
	train: [
		user("Fine-tune the ranking model on last week's click logs, 3 epochs."),
		say("The data is ready in `data/clicks-w46.parquet`. I'll start the training run."),
		call("p1", "Bash", { command: "python train.py --data data/clicks-w46.parquet --epochs 3 --lr 2e-5" }),
	],
	charts: [
		user("Build the usage dashboard. Pick a charting library first."),
		say("Three libraries fit the bundle budget. Which one should the dashboard use?"),
	],
	flaky: [
		user("The login test fails about one run in ten. Find out why."),
		say("Found it: the test waits a fixed 200ms for the session cookie. It now waits for the cookie itself; 50 runs in a row pass."),
	],
};

/** What the agent does next in a session, once you reply, approve or answer. */
const REPLIES: Record<string, Rec[]> = {
	gateway: [
		think("A counter labelled by route is enough; the metrics registry is already exported on /metrics."),
		call("g1", "Edit", { file_path: "src/gateway/ratelimit.ts" }),
		result("g1", {
			diff: "@@ -12,6 +12,7 @@\n     if (!bucket.take()) {\n+      rejected.inc({ route: req.route });\n       res.set('Retry-After', String(bucket.retryAfter()));\n       return res.status(429).end();",
		}),
		call("g2", "Bash", { command: "npm test -- ratelimit" }),
		result("g2", "4 passed (430ms)"),
		say("Rejected requests now count in `gateway_ratelimit_rejected_total`, labelled by route."),
	],
	train: [
		result("p1", "epoch 1/3  loss 0.412\nepoch 2/3  loss 0.297\nepoch 3/3  loss 0.254\nsaved checkpoints/ranker-w46.pt"),
		say("Training finished: **NDCG@10** went from 0.61 to 0.66 on the held-out week."),
	],
	charts: [
		say("uPlot it is. I'll start with the requests-per-minute chart."),
		call("d1", "Bash", { command: "npm install uplot" }),
		result("d1", "added 1 package in 2s"),
	],
};

// --- sessions ----------------------------------------------------------------

interface Spec {
	id: string;
	title: string;
	flavor: string;
	machine: string;
	path: string;
	ago: number;
	active?: boolean;
	busy?: boolean;
	requests?: Record<string, Omit<PermissionRequest, "id">>;
}

const SPECS: Spec[] = [
	{ id: "gateway", title: "Add rate limiting to the API gateway", flavor: "claude", machine: "m-studio", path: "code/orbit", ago: 2 * min },
	{ id: "ci", title: "Move CI to the arm64 runners", flavor: "codex", machine: "m-build", path: "code/orbit", ago: 0, busy: true },
	{
		id: "train",
		title: "Fine-tune the ranking model",
		flavor: "pi",
		machine: "m-gpu",
		path: "ml/ranker",
		ago: 1 * min,
		requests: {
			r1: { tool: "Bash", arguments: { command: "python train.py --data data/clicks-w46.parquet --epochs 3 --lr 2e-5" } },
		},
	},
	{
		id: "charts",
		title: "Usage dashboard",
		flavor: "claude",
		machine: "m-studio",
		path: "code/console",
		ago: 4 * min,
		requests: {
			q1: {
				tool: "AskUserQuestion",
				arguments: {
					questions: [
						{
							question: "Which charting library should the dashboard use?",
							options: [
								{ label: "ECharts", description: "Every chart type, canvas, 300 kB" },
								{ label: "uPlot", description: "Tiny and very fast, time series only" },
								{ label: "Recharts", description: "React components, SVG, easy to style" },
							],
						},
					],
				},
			},
		},
	},
	{ id: "flaky", title: "Fix the flaky login test", flavor: "claude", machine: "m-build", path: "code/console", ago: 9 * min },
	{ id: "notes", title: "Release notes for 2.4", flavor: "opencode", machine: "m-studio", path: "code/orbit", ago: 3 * 60 * min },
	{ id: "infra", title: "Terraform for the staging cluster", flavor: "codex", machine: "m-build", path: "infra", ago: 26 * 60 * min, active: false },
	{ id: "docs", title: "Rewrite the onboarding guide", flavor: "claude", machine: "m-studio", path: "docs", ago: 3 * 24 * 60 * min, active: false },
];

function toSession(spec: Spec): Session {
	const requests = Object.fromEntries(
		Object.entries(spec.requests ?? {}).map(([id, r]) => [id, { ...r, createdAt: now - spec.ago }]),
	);
	const count = Object.keys(requests).length;
	const host = MACHINES.find((m) => m.id === spec.machine)?.metadata.host;
	return {
		id: spec.id,
		seq: TRANSCRIPTS[spec.id]?.length ?? 0,
		createdAt: now - spec.ago - 30 * min,
		updatedAt: now - spec.ago,
		activityAt: now - spec.ago,
		active: spec.active ?? true,
		activeAt: now,
		archivedAt: null,
		encryptionMode: "plain",
		// Any non-null key: the demo never decrypts anything.
		key: {} as Session["key"],
		metadata: {
			name: spec.title,
			flavor: spec.flavor,
			machineId: spec.machine,
			host,
			path: `${HOME}/${spec.path}`,
			homeDir: HOME,
			permissionMode: "default",
			providerAccountUsageRefsV1: spec.flavor === "claude" ? { v: 1, recordIds: ["demo"], updatedAtMs: now } : undefined,
		},
		metadataVersion: 1,
		agentState: { requests },
		agentStateVersion: 1,
		thinking: spec.busy === true,
		// A turn waiting for an approval or an answer is still in progress.
		latestTurnStatus: spec.busy || count > 0 ? "in_progress" : "completed",
		pendingCount: 0,
		pendingPermissionRequestCount: count,
		pendingUserActionRequestCount: 0,
	};
}

/** The transcript, one record every 20 seconds up to the session's last activity. */
function rows(id: string): MessageRow[] {
	const records = TRANSCRIPTS[id] ?? [];
	const end = now - (SPECS.find((s) => s.id === id)?.ago ?? 0);
	return records.map((record, i) => ({
		id: `${id}-${i + 1}`,
		seq: i + 1,
		localId: null,
		createdAt: end - (records.length - 1 - i) * 20_000,
		sidechainId: null,
		record,
	}));
}

// --- client --------------------------------------------------------------------

const config = {
	homeDir: "/nonexistent",
	serverId: "demo",
	serverName: "happier.example.com",
	serverUrl: "https://happier.example.com",
	token: "",
	keys: {},
	machineId: "m-studio",
} as unknown as HappierConfig;

class DemoClient extends HappierClient {
	constructor() {
		super(config);
		for (const m of MACHINES) this.machines.set(m.id, m);
		for (const s of SPECS) this.sessions.set(s.id, toSession(s));
	}
	override async refreshSessions() {
		return [...this.sessions.values()];
	}
	override async refreshSession(id: string) {
		return this.sessions.get(id)!;
	}
	override async refreshMachines() {
		return [...this.machines.values()];
	}
	override async getMachine(id: string) {
		return this.machines.get(id);
	}
	override async fetchMessages(session: Session, opts: { afterSeq?: number } = {}): Promise<MessagePage> {
		const messages = opts.afterSeq === undefined ? rows(session.id) : [];
		return { messages, hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
	}
	/** The Claude account's plan limits, as its agents report them. */
	override async providerUsageRecords() {
		const meter = (meterId: string, label: string, utilizationPct: number, resetIn: number) => ({
			meterId, label, utilizationPct, resetAtMs: Date.now() + resetIn, unit: "unknown", status: "ok", details: { limitCategory: "usage_limit" },
		});
		return [{ providerId: "claude", state: "loaded_data", fetchedAtMs: Date.now(), meters: [meter("five_hour", "5-hour", 48, 2.2 * 3_600_000), meter("seven_day", "Weekly", 74, 2.6 * 86_400_000)] }];
	}
	override async listFiles() {
		return ["src/gateway/server.ts", "src/gateway/ratelimit.ts", "src/gateway/auth.ts", "README.md"];
	}
	override async sendMessage(session: Session, text: string) {
		const record = user(text);
		const localId = `local-${Date.now()}`;
		this.append(session.id, record, localId);
		void this.play(session.id);
		return { localId, record };
	}
	override async respondPermission(session: Session) {
		void this.play(session.id);
	}
	override async respondQuestion(session: Session) {
		void this.play(session.id);
	}

	private update(id: string, change: Partial<Session>): Session {
		const next = { ...this.sessions.get(id)!, ...change };
		this.sessions.set(id, next);
		this.emit("session", next);
		return next;
	}

	private append(id: string, record: Rec, localId: string | null = null): void {
		const s = this.update(id, { activityAt: Date.now() });
		const seq = s.seq + 1;
		this.update(id, { seq });
		this.emit("message", id, { id: `${id}-${seq}`, seq, localId, createdAt: Date.now(), sidechainId: null, record });
	}

	/** The session's scripted reply, one record at a time, as a turn in progress. */
	private async play(id: string): Promise<void> {
		const records = REPLIES[id] ?? [say("Done.")];
		delete REPLIES[id];
		const pause = () => new Promise((r) => setTimeout(r, 900));
		this.update(id, {
			agentState: { requests: {} },
			pendingPermissionRequestCount: 0,
			thinking: true,
			latestTurnStatus: "in_progress",
		});
		for (const record of records) {
			await pause();
			this.append(id, record);
		}
		await pause();
		this.update(id, { thinking: false, latestTurnStatus: "completed" });
	}
	override async listQueue() {
		return [];
	}
	override connect() {
		this.connected = true;
		this.emit("connection", "connected");
		// A reply arriving in another session: it shows as "new reply" on the start screen.
		setTimeout(() => {
			const [row] = rows("flaky").slice(-1);
			if (row) this.emit("message", "flaky", row);
		}, 200);
	}
	override setUiFocus() {}
	override markRead() {}
	override close() {}
}

const app = new App(new DemoClient(), process.argv[2], { osc: false, bell: false });
await app.start();
await app.done;
process.exit(0);
