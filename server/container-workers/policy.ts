import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { validateWorkerEnvironment } from "./environment.ts";
export { validateWorkerEnvironment } from "./environment.ts";
import type { AnyProviderDriver, InstanceConfig, ProviderInstance, SendTurnInput } from "../contracts.ts";

const workerSchema = z.object({
  instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  image: z.string().min(1),
  command: z.array(z.string()).min(1).optional(),
  home: z.string(),
  temp: z.string(),
  workspaces: z.array(z.string()).min(1),
  network: z.string().regex(/^[a-zA-Z0-9_.-]+$/).default("none"),
  user: z.string().regex(/^\d+:\d+$/).default("1000:1000"),
}).strict();
const schema = z.object({
  docker: z.string().default("/usr/bin/docker"),
  dockerConfig: z.string().optional(),
  context: z.string().optional(),
  workers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), workerSchema),
}).strict();
export type Worker = z.infer<typeof workerSchema>;
export type WorkerPolicy = z.infer<typeof schema>;
export const containsPath = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

function canonicalDestination(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error("Worker path has no existing ancestor");
    parent = next;
  }
  return join(realpathSync(parent), ...missing);
}

export function readWorkerPolicy(path: string): WorkerPolicy {
  const policy = schema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (policy.dockerConfig && !isAbsolute(policy.dockerConfig)) throw new Error("Docker configuration must use an absolute operator-owned directory");
  const roots: string[] = [];
  const instances = new Set<string>();
  const networks = new Set<string>();
  for (const worker of Object.values(policy.workers)) {
    if (instances.has(worker.instanceId)) throw new Error("A container engine belongs to exactly one bot");
    instances.add(worker.instanceId);
    if (["host", "bridge", "container"].includes(worker.network)) throw new Error("Use none or a dedicated worker network");
    if (worker.network !== "none") {
      if (networks.has(worker.network)) throw new Error("Each worker requires its own Docker network");
      networks.add(worker.network);
    }
    if (worker.user.split(":").some((part) => !Number.isSafeInteger(Number(part)) || Number(part) < 1 || Number(part) > 4_294_967_294)) throw new Error("Workers require non-root numeric user and group IDs");
    for (const root of [worker.home, worker.temp, ...worker.workspaces]) {
      if (!isAbsolute(root) || root !== realpathSync(root) || !statSync(root).isDirectory() || /[,\r\n\0]/.test(root)) throw new Error("Worker mounts must be canonical absolute directories");
      const protectedRoots = [dirname(resolve(path)), dirname(realpathSync(path)), ...(policy.dockerConfig ? [canonicalDestination(policy.dockerConfig)] : []), join(homedir(), ".ssh"), join(homedir(), ".docker"), "/var/run", "/run", "/proc", "/sys", "/dev"].map((entry) => existsSync(entry) ? realpathSync(entry) : entry);
      if (protectedRoots.some((other) => containsPath(root, other) || containsPath(other, root)) || roots.some((other) => containsPath(root, other) || containsPath(other, root))) {
        throw new Error("Worker mounts must not overlap or expose coordinator or administrative directories");
      }
      roots.push(root);
    }
    for (const root of worker.workspaces) {
      if (["/home/agent", "/opt/omb", "/proc", "/sys", "/dev"].some((target) => containsPath(root, target) || containsPath(target, root)) || root === "/tmp") {
        throw new Error("Workspace destination overlaps a reserved worker directory");
      }
    }
  }
  return policy;
}


/** Operator-owned policy: every engine is contained, and each belongs to exactly one bot. */
export class ContainerWorkers {
  readonly policy: WorkerPolicy;
  readonly path: string;
  constructor(path: string) { this.path = path; this.policy = readWorkerPolicy(path); }
  static open(path: string): ContainerWorkers | undefined {
    if (!existsSync(path)) return undefined;
    if (process.platform === "win32") throw new Error("Container workers currently require a Linux or macOS coordinator and Linux container images");
    return new ContainerWorkers(path);
  }
  async create(instanceId: string, entry: InstanceConfig, driver: AnyProviderDriver): Promise<ProviderInstance> {
    const worker = Object.values(this.policy.workers).find((value) => value.instanceId === instanceId);
    if (!worker) throw new Error("Container policy refuses an unassigned engine");
    const botId = Object.entries(this.policy.workers).find(([, value]) => value.instanceId === instanceId)![0];
    validateWorkerEnvironment(entry.environment ?? {});
    const { createContainerProvider } = await import("./provider.ts");
    const { spawnContainerWorker } = await import("./transport.ts");
    return createContainerProvider({ botId, driverKind: entry.driver,
      input: { instanceId, displayName: entry.displayName ?? driver.metadata.displayName, enabled: entry.enabled ?? true,
        config: entry.config ?? {}, environment: entry.environment ?? {} },
      spawn: () => spawnContainerWorker(this.path, botId),
      validateTurn: (turn) => this.validateTurn(botId, turn),
    });
  }
  validateTurn(botId: string, turn: SendTurnInput): void {
    const worker = this.policy.workers[botId];
    if (!worker || turn.botId !== botId) throw new Error("Container policy refuses this bot/engine assignment");
    const allowed = (path: string) => isAbsolute(path) && worker.workspaces.some((root) => containsPath(root, canonicalDestination(path)));
    if (!turn.cwd || !allowed(turn.cwd)) throw new Error("Container policy refuses a working directory outside this bot's mounts");
    for (const path of [turn.toolResultFolder, turn.userSkillsDir, turn.botSettingsFile, ...(turn.images ?? []).map((image) => image.path)]) {
      if (path && !allowed(path)) throw new Error("Container policy refuses a turn path outside this bot's workspace mounts");
    }
  }
  workingDirectory(botId: string, preferred?: string): string {
    const worker = this.policy.workers[botId];
    if (!worker) throw new Error("Container policy refuses an unassigned recipient bot");
    const cwd = preferred ?? worker.workspaces[0]!;
    if (!isAbsolute(cwd) || !worker.workspaces.some((root) => containsPath(root, realpathSync(cwd))) || !statSync(cwd).isDirectory()) {
      throw new Error("Container recipient working directory is outside its workspace mounts");
    }
    return cwd;
  }
}
