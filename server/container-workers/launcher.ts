import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkerPolicy, containsPath } from "./policy.ts";
import { agentsMcp } from "../drivers/agents-mcp.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import type { Json } from "../drivers/agents-client.ts";

const [policyPath, instanceId, ...originalArgs] = process.argv.slice(2);
if (!policyPath || !instanceId) throw new Error("Expected policy path and instance id");
const policy = readWorkerPolicy(policyPath);
const entry = Object.entries(policy.workers).find(([, worker]) => worker.instanceId === instanceId);
if (!entry) throw new Error("Unassigned container engine");
const [botId, worker] = entry;
if (process.env.OMB_BOT_ID && process.env.OMB_BOT_ID !== botId) throw new Error("Container bot identity mismatch");
const appServer = originalArgs[0] === "app-server";
const key = createHash("sha256").update(`${policyPath}:${botId}`).digest("hex").slice(0, 16);
const name = `omb-worker-${key}${appServer ? "" : `-probe-${randomUUID()}`}`;
const runId = randomUUID();
const bridgeSocket = `/tmp/omb-${randomUUID()}.sock`;
const dockerArgs = [...(policy.dockerConfig ? ["--config", policy.dockerConfig] : []), ...(policy.context ? ["--context", policy.context] : [])];
const source = dirname(fileURLToPath(import.meta.url));
const args: string[] = [];
for (let index = 0; index < originalArgs.length; index++) {
  const value = originalArgs[index]!;
  if ((value === "-c" || value === "--config") && originalArgs[index + 1]?.startsWith("mcp_servers.")) { index++; continue; }
  args.push(value);
}
const scope = JSON.parse(process.env.OMB_CONTAINER_TOOL_SCOPE ?? "null");
const allowed = new Set(["coordinate_bots", "assignment_status"]);
const agentsEnv = { ...process.env, OMB_AGENTS_TOOL_BRIDGE: "0" };
const handle = agentsMcp(agentsEnv);
const hasBridge = appServer && process.env.OMB_BOT_ID === botId && Boolean(process.env.OMB_HARNESS_URL);
if (hasBridge) args.push("-c", 'mcp_servers.agents.command="node"', "-c", 'mcp_servers.agents.args=["/opt/omb/mcp-client.mjs"]',
  "-c", 'mcp_servers.agents.env_vars=["OMB_BRIDGE_SOCKET"]', "-c", 'mcp_servers.agents.default_tools_approval_mode="approve"',
  "-c", "mcp_servers.agents.tool_timeout_sec=300");
const cwd = worker.workspaces.find((root) => containsPath(root, process.cwd())) ? process.cwd() : worker.workspaces[0]!;
const mount = (from: string, to: string, readonly = false) => ["--mount", `type=bind,src=${from},dst=${to}${readonly ? ",readonly" : ""}`];
const child = spawn(policy.docker, [...dockerArgs, "run", "--rm", "--init", "-i", "--name", name,
  "--label", "org.openmausbot.container-worker=true", "--label", `org.openmausbot.bot=${botId}`,
  "--label", `org.openmausbot.run=${runId}`,
  "--label", `org.openmausbot.policy=${createHash("sha256").update(policyPath).digest("hex")}`,
  "--user", worker.user, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--cpus=1",
  "--network", worker.network, "--workdir", cwd,
  "--env", "HOME=/home/agent", "--env", "CODEX_HOME=/home/agent/.codex", "--env", "TMPDIR=/tmp",
  "--env", `OMB_BRIDGE_SOCKET=${bridgeSocket}`,
  ...mount(worker.home, "/home/agent"), ...mount(worker.temp, "/tmp"),
  ...worker.workspaces.flatMap((root) => mount(root, root)),
  ...mount(`${source}/worker.mjs`, "/opt/omb/worker.mjs", true), ...mount(`${source}/mcp-client.mjs`, "/opt/omb/mcp-client.mjs", true),
  "--entrypoint", "node", worker.image, "/opt/omb/worker.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
child.stdin.on("error", () => {});
child.stderr.pipe(process.stderr);
send({ start: [...worker.command, ...args] });
let inflight = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const envelope = JSON.parse(line);
    if (typeof envelope.stdout === "string") process.stdout.write(Buffer.from(envelope.stdout, "base64"));
    else if (typeof envelope.stderr === "string") process.stderr.write(Buffer.from(envelope.stderr, "base64"));
    else if (typeof envelope.bridge === "string" && envelope.message && hasBridge) {
      const message = envelope.message as Json;
      const params = (message.params ?? {}) as Json;
      const name = params.name as string;
      const refused = () => send({ bridge: envelope.bridge, message: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Container coordination policy refused this request" } } });
      if (inflight >= 16 || !["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"].includes(String(message.method)) ||
        (message.method === "tools/call" && (!allowed.has(name) || !allowsTool(scope ?? undefined, { kind: "mcp", server: "agents", name }, params.arguments)))) return refused();
      inflight++;
      void handle(message).then((response) => {
        if (response && message.method === "tools/list") {
          const result = response.result as { tools?: { name: string }[] };
          if (result.tools) result.tools = result.tools.filter((tool) => allowed.has(tool.name) && allowsTool(scope ?? undefined, { kind: "mcp", server: "agents", name: tool.name }));
        }
        if (response) send({ bridge: envelope.bridge, message: response });
      }, refused).finally(() => inflight--);
    }
  } catch { child.stdin.end(); }
});
process.stdin.on("data", (chunk: Buffer) => send({ stdin: chunk.toString("base64") }));
process.stdin.on("end", () => send({ end: true }));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.stdin.end();
  const found = spawnSync(policy.docker, [...dockerArgs, "inspect", "--format", '{{index .Config.Labels "org.openmausbot.run"}}', name], { encoding: "utf8", timeout: 5_000 });
  if (found.status === 0 && found.stdout.trim() === runId) spawnSync(policy.docker, [...dockerArgs, "rm", "-f", name], { stdio: "ignore", timeout: 10_000 });
}
process.on("SIGTERM", () => { stop(); process.exit(143); });
process.on("SIGINT", () => { stop(); process.exit(130); });
const parent = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== parent) { stop(); process.exit(1); }
}, 500);
parentWatch.unref();
child.on("error", (error) => { console.error(error.message); stop(); process.exit(1); });
child.on("exit", (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
process.on("exit", stop);
