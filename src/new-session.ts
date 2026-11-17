import { hostname } from "node:os";
import { type HappierClient, HappierError, type Machine } from "./happier/client.js";
import { errorText, machineName, shortHost } from "./ui/format.js";
import type { PickerOptions } from "./ui/picker.js";
import { agoText, shortPath } from "./ui/theme.js";

const FALLBACK_AGENTS = ["claude", "codex", "opencode", "pi", "gemini"];
const AGENT_PROBE_WAIT_MS = 4000;

/** What the flow needs from the application shell. */
export interface FlowUi {
	client: HappierClient;
	/** Shows a modal list; resolves the chosen value, or null when dismissed. */
	pick(opts: Omit<PickerOptions, "onSelect" | "onCancel">): Promise<string | null>;
	flash(text: string, level?: "info" | "warn" | "error", ms?: number): void;
	clearNotice(): void;
}

/** Starts a session on this computer in a known directory, skipping those wizard steps. */
export interface LocalLaunch {
	directory: string;
	/** Agent to start; asked for when omitted. */
	agent?: string;
}

/** The "new session" wizard: pick a machine, an agent and a directory, then spawn. */
export class NewSessionFlow {
	private readonly detectedAgents = new Map<string, string[]>();
	private readonly agentProbes = new Map<string, Promise<string[]>>();

	constructor(private readonly ui: FlowUi) {}

	/** Walks machine → agent → directory and starts the session. Resolves its id, or null when cancelled. */
	async run(local?: LocalLaunch): Promise<string | null> {
		const machines = (await this.ui.client.refreshMachines()).filter((m) => m.active);
		if (machines.length === 0) {
			this.ui.flash("No machine is online. Start the Happier daemon on one (`happier daemon start`).", "warn", 8000);
			return null;
		}
		let machine: Machine | undefined;
		if (local) {
			machine = this.localMachine(machines);
			if (!machine) {
				this.ui.flash("This computer is not online in Happier. Start its daemon (`happier daemon start`).", "warn", 8000);
				return null;
			}
		} else {
			const machineId =
				machines.length === 1
					? machines[0]!.id
					: await this.ui.pick({
							title: "New session · machine",
							noFilter: true,
							items: machines.map((m) => ({
								value: m.id,
								label: machineName(m),
								description: `${m.metadata.platform ?? ""} · happier ${m.metadata.happyCliVersion ?? "?"}`,
							})),
						});
			machine = machines.find((m) => m.id === machineId);
		}
		if (!machine) return null;

		let agent = local?.agent ?? null;
		if (!agent) {
			const { agents, detected } = await this.agentsFor(machine);
			agent = await this.ui.pick({
				title: `New session on ${machineName(machine)}${local ? ` in ${shortPath(local.directory, machine.metadata.homeDir)}` : ""} · agent`,
				noFilter: true,
				hint: detected ? undefined : "could not confirm which agents are installed — showing the usual ones",
				items: agents.map((a) => ({ value: a, label: a })),
			});
		}
		if (!agent) return null;

		const directory = local?.directory ?? (await this.pickDirectory(machine));
		if (!directory) return null;

		this.ui.flash(`Starting ${agent} in ${directory}…`, "info", 60_000);
		const res = await this.ui.client.spawnSession(machine, { directory, agent });
		if (res.type === "error") throw new HappierError(`Could not start session: ${res.errorMessage}`);
		if (res.type === "requestToApproveDirectoryCreation") {
			throw new HappierError(`Directory does not exist: ${res.directory}`);
		}
		if (!res.sessionId) {
			this.ui.flash("Session is starting; it will appear in the list shortly.", "info", 8000);
			return null;
		}
		await this.ui.client.waitForSession(res.sessionId);
		this.ui.clearNotice();
		return res.sessionId;
	}

	/** The machine this computer's daemon registered as: by stored id, else by host name. */
	private localMachine(machines: Machine[]): Machine | undefined {
		const id = this.ui.client.config.machineId;
		const host = shortHost(hostname()).toLowerCase();
		return machines.find((m) => m.id === id) ?? machines.find((m) => shortHost(m.metadata.host).toLowerCase() === host);
	}

	/**
	 * Agents to offer on a machine. The daemon's probe checks every agent CLI and can take a long
	 * time, so it never blocks the wizard for more than a few seconds: the result is cached per
	 * machine, and until it arrives we offer the agents already used there plus the common ones.
	 */
	private async agentsFor(machine: Machine): Promise<{ agents: string[]; detected: boolean }> {
		const cached = this.detectedAgents.get(machine.id);
		if (cached) return { agents: cached, detected: true };

		let probe = this.agentProbes.get(machine.id);
		if (!probe) {
			probe = this.ui.client
				.detectAgents(machine)
				.then((found) => {
					if (found.length > 0) this.detectedAgents.set(machine.id, found);
					return found;
				})
				.catch(() => [] as string[])
				.finally(() => this.agentProbes.delete(machine.id));
			this.agentProbes.set(machine.id, probe);
		}
		this.ui.flash(`Checking agents installed on ${machineName(machine)}…`, "info", AGENT_PROBE_WAIT_MS);
		const found = await Promise.race([
			probe,
			new Promise<string[]>((resolve) => setTimeout(() => resolve([]), AGENT_PROBE_WAIT_MS)),
		]);
		this.ui.clearNotice();
		if (found.length > 0) return { agents: found, detected: true };

		const used = new Set<string>();
		for (const s of this.ui.client.sessions.values()) {
			if (s.metadata.machineId === machine.id && typeof s.metadata.flavor === "string") used.add(s.metadata.flavor);
		}
		return { agents: [...new Set([...used, ...FALLBACK_AGENTS])], detected: false };
	}

	private async pickDirectory(machine: Machine): Promise<string | null> {
		const home = typeof machine.metadata.homeDir === "string" ? machine.metadata.homeDir : "/";
		const recent = new Map<string, number>();
		for (const s of this.ui.client.sessions.values()) {
			if (s.metadata.machineId !== machine.id || typeof s.metadata.path !== "string") continue;
			recent.set(s.metadata.path, Math.max(recent.get(s.metadata.path) ?? 0, s.activityAt));
		}
		const recents = [...recent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
		const first = await this.ui.pick({
			title: "New session · directory",
			items: [
				{ value: "\0browse", label: "Browse…", description: "pick a folder on the machine" },
				...recents.map(([p, at]) => ({ value: p, label: shortPath(p, home), description: `used ${agoText(at)}` })),
			],
		});
		if (first !== "\0browse") return first;

		let path = home;
		for (;;) {
			let dirs: string[] = [];
			try {
				const listing = await this.ui.client.listDirectory(machine, path);
				path = listing.path;
				dirs = listing.dirs.filter((d) => !d.startsWith("."));
			} catch (e) {
				this.ui.flash(`Cannot list ${path}: ${errorText(e)}`, "warn");
				if (path === home) return null;
				path = home;
				continue;
			}
			const choice = await this.ui.pick({
				title: shortPath(path, home) || "/",
				hint: "enter to open a folder · pick the first row to start here",
				items: [
					{ value: "\0use", label: "✓ Start session here", description: path },
					...(path !== "/" ? [{ value: "\0up", label: ".." }] : []),
					...dirs.map((d) => ({ value: d, label: `${d}/` })),
				],
			});
			if (choice === null) return null;
			if (choice === "\0use") return path;
			if (choice === "\0up") path = path.replace(/\/[^/]+\/?$/, "") || "/";
			else path = `${path.replace(/\/$/, "")}/${choice}`;
		}
	}
}
