import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SERVER_ROOT } from "../proxy-paths.ts";

/** Starts the trusted supervisor; worker credentials travel only on the returned private stdin. */
export function spawnContainerWorker(policyPath: string, botId: string): ChildProcessWithoutNullStreams {
  const source = join(SERVER_ROOT, "container-workers", "launcher.ts");
  const launcher = existsSync(source) ? source : join(SERVER_ROOT, "container-workers", "launcher.js");
  return spawn(process.execPath, [...(launcher.endsWith(".ts") ? ["--experimental-strip-types"] : []), launcher, policyPath, botId], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: "1" },
  });
}
