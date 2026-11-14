import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { narrowsNativeTools } from "../../shared/tool-scope.ts";
import type { InstanceConfigMap, ProviderInstance } from "../contracts.ts";

const workerSchema = z.object({
  instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  image: z.string().min(1),
  command: z.array(z.string()).min(1),
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

export function readWorkerPolicy(path: string): WorkerPolicy {
  const policy = schema.parse(JSON.parse(readFileSync(path, "utf8")));
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
    if (worker.user.split(":")[0] === "0") throw new Error("Workers must run as a non-root user");
    for (const root of [worker.home, worker.temp, ...worker.workspaces]) {
      if (!isAbsolute(root) || root !== realpathSync(root) || /[,\r\n]/.test(root)) throw new Error("Worker mounts must be canonical absolute directories");
      if (containsPath(root, resolve(path)) || roots.some((other) => containsPath(root, other) || containsPath(other, root))) {
        throw new Error("Worker mounts must not overlap or expose the policy");
      }
      roots.push(root);
    }
  }
  return policy;
}

/** Operator-owned policy: every engine is contained, and each belongs to exactly one bot. */
export class ContainerWorkers {
  readonly policy: WorkerPolicy;
  readonly path: string;
  constructor(path: string) { this.path = path; this.policy = readWorkerPolicy(path); }
  static open(path: string): ContainerWorkers | undefined { return existsSync(path) ? new ContainerWorkers(path) : undefined; }
  entry(instanceId: string, entry: InstanceConfigMap[string]): InstanceConfigMap[string] {
    const worker = Object.values(this.policy.workers).find((value) => value.instanceId === instanceId);
    if (!worker) throw new Error("Container policy refuses an unassigned engine");
    if (entry.driver !== "codex") throw new Error("Container workers currently require the native Codex driver");
    const launcher = fileURLToPath(new URL("./launcher.ts", import.meta.url));
    const quote = (value: string) => {
      if (value.includes('"')) throw new Error("Container launcher paths cannot contain quotes");
      return `"${value}"`;
    };
    return { driver: "codex", displayName: entry.displayName, enabled: entry.enabled,
      config: { cli: [process.execPath, "--experimental-strip-types", launcher, this.path, instanceId].map(quote).join(" ") },
      environment: { HOME: worker.home, CODEX_HOME: `${worker.home}/.codex` } };
  }
  wrap(instance: ProviderInstance): ProviderInstance {
    const botId = Object.entries(this.policy.workers).find(([, worker]) => worker.instanceId === instance.instanceId)?.[0];
    const adapter = instance.adapter;
    const wrapped = Object.create(instance) as ProviderInstance;
    // These background APIs carry no bot identity, so they cannot establish which worker may receive the prompt.
    for (const method of ["generateText", "generateMemoryText", "reviewPermission"] as const) Object.defineProperty(wrapped, method, { value: undefined });
    Object.defineProperty(wrapped, "adapter", { value: { ...adapter,
      capabilities: { ...adapter.capabilities, browserMcp: false, computerMcp: false, localComputerMcp: false,
        customMcp: false, composioMcp: false, phoneMcp: false, dataMcp: false, emailMcp: false, deviceMcp: false, hooks: false },
      sendTurn: async (turn: Parameters<typeof adapter.sendTurn>[0]) => {
        if (!botId || turn.botId !== botId) throw new Error("Container policy refuses this bot/engine assignment");
        if (narrowsNativeTools(turn.toolScope)) throw new Error("Native tool restrictions are not supported by this container integration");
        const worker = this.policy.workers[botId]!;
        if (!turn.cwd || !worker.workspaces.some((root) => containsPath(root, realpathSync(turn.cwd!)))) throw new Error("Container policy refuses a working directory outside this bot's mounts");
        const agents = turn.integrations?.agents;
        return adapter.sendTurn({ ...turn, toolScope: undefined, integrations: agents ? { agents: {
          ...agents, env: { ...agents.env, OMB_CONTAINER_TOOL_SCOPE: JSON.stringify(turn.toolScope ?? null) },
        } } : {} });
      },
    } });
    return wrapped;
  }
}
