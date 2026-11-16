// Clean build: compile src/ to dist/ and make the command entry point executable.
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "."], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
// tsc writes plain files; a linked install (`npm install -g .`) runs dist/main.js directly.
chmodSync("dist/main.js", 0o755);
