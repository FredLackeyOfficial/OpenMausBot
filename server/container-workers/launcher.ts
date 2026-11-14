import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readWorkerPolicy } from "./policy.ts";
import { createWorkerTemp } from "./temp.ts";

// The provider may reuse a generation only after this supervisor confirms cleanup.
// Uncaught exceptions and unexpected exits must not masquerade as ordinary worker exits.
let cleanupConfirmed = false;
process.on("exit", () => { if (!cleanupConfirmed) process.exitCode = 70; });

const [policyPath, botId, ...extra] = process.argv.slice(2);
if (!policyPath || !botId || extra.length) throw new Error("Expected container policy path and bot id");
const policy = readWorkerPolicy(policyPath);
const worker = policy.workers[botId];
if (!worker) throw new Error("Unassigned container bot");
const policyHash = createHash("sha256").update(policyPath).digest("hex");
const key = createHash("sha256").update(`${policyHash}:${botId}`).digest("hex").slice(0, 24);
const name = `omb-worker-${key}`;
const runId = randomUUID();
const dockerArgs = [...(policy.dockerConfig ? ["--config", policy.dockerConfig] : []), ...(policy.context ? ["--context", policy.context] : [])];
const dockerEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const temp = createWorkerTemp(worker);
const [uid, gid] = worker.user.split(":");
const mount = (from: string, to: string) => ["--mount", `type=bind,src=${from},dst=${to}`];
const createArgs = [...dockerArgs, "create", "--rm", "--init", "-i", "--name", name,
  "--label", "org.openmausbot.container-worker=true", "--label", `org.openmausbot.bot=${botId}`,
  "--label", `org.openmausbot.run=${runId}`, "--label", `org.openmausbot.policy=${policyHash}`,
  "--user", worker.user, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--pids-limit=128", "--memory=1g", "--cpus=1", "--network", worker.network,
  "--tmpfs", `/run/omb:rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=${uid},gid=${gid}`,
  "--workdir", worker.workspaces[0]!,
  "--env", "HOME=/home/agent", "--env", "TMPDIR=/tmp", "--env", "TMP=/tmp", "--env", "TEMP=/tmp",
  "--env", "PATH=/usr/local/bin:/usr/bin:/bin", "--env", "OMB_DATA_DIR=/home/agent/.openmausbot",
  "--env", "XDG_RUNTIME_DIR=/run/omb", "--env", "OMB_CONTAINER_IPC_DIR=/run/omb",
  "--env", "XDG_CONFIG_HOME=/home/agent/.config", "--env", "XDG_CACHE_HOME=/home/agent/.cache",
  "--env", "XDG_DATA_HOME=/home/agent/.local/share", "--env", "XDG_STATE_HOME=/home/agent/.local/state",
  ...mount(worker.home, "/home/agent"), ...mount(temp, "/tmp"),
  ...worker.workspaces.flatMap((root) => mount(root, root)),
  "--entrypoint", "node", worker.image, "/opt/omb/runtime/container-worker.js"];

let attach: ReturnType<typeof spawn> | undefined;
let stopRequested = false, requestedCode = 0;
let notifyStop!: () => void;
const stopped = new Promise<void>((resolve) => { notifyStop = resolve; });
const requestStop = (code: number) => { stopRequested = true; requestedCode = code; notifyStop(); };
let buffered: Buffer[] = [], bufferedBytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  if (stopRequested) return;
  if (attach?.stdin) {
    if (!attach.stdin.write(chunk)) process.stdin.pause();
  } else {
    bufferedBytes += chunk.length;
    if (bufferedBytes > 16 * 1024 * 1024) requestStop(1);
    else buffered.push(chunk);
  }
});
process.stdin.on("end", () => requestStop(0));
process.stdin.on("error", () => requestStop(1));
process.stdout.on("error", () => requestStop(1));
process.stderr.on("error", () => requestStop(1));
process.on("SIGTERM", () => requestStop(143));
process.on("SIGINT", () => requestStop(130));
const parent = process.ppid;
const parentWatch = setInterval(() => { if (process.ppid !== parent) requestStop(1); }, 500);
parentWatch.unref();

interface Creation { code: number | null; id?: string; uncertain: boolean; error?: string }
const creation = await new Promise<Creation>((resolve) => {
  // Creation cannot execute the worker or receive provider credentials; Stop waits for this transaction before start.
  const child = spawn(policy.docker, createArgs, { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv });
  let output = "", errors = "", uncertain = false, spawnError: string | undefined;
  const timer = setTimeout(() => { uncertain = true; child.kill("SIGKILL"); }, 10_000);
  child.stdout.on("data", (chunk: Buffer) => { output = (output + String(chunk)).slice(-1024); });
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + String(chunk)).slice(-4096); });
  child.on("error", (error) => { spawnError = error.message; });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    const id = output.trim();
    resolve({ code, ...(code === 0 && /^[a-f0-9]{64}$/.test(id) ? { id } : {}), uncertain: uncertain || signal !== null,
      ...(spawnError || errors ? { error: spawnError ?? errors } : {}) });
  });
});
if (creation.error) process.stderr.write(`${creation.error}\n`);

function cleanup(): boolean {
  const target = creation.id ?? name;
  const found = spawnSync(policy.docker, [...dockerArgs, "inspect", "--format", '{{.Id}} {{index .Config.Labels "org.openmausbot.run"}}', target],
    { encoding: "utf8", timeout: 3_000, env: dockerEnv });
  const [containerId, owner] = found.stdout?.trim().split(/\s+/) ?? [];
  let complete = false;
  if (found.status === 0 && owner === runId && /^[a-f0-9]{64}$/.test(containerId ?? "")) {
    const removed = spawnSync(policy.docker, [...dockerArgs, "rm", "-f", containerId!], { stdio: "ignore", timeout: 5_000, env: dockerEnv });
    complete = removed.status === 0;
    const deadline = Date.now() + 2_000;
    while (!complete && Date.now() < deadline) {
      const remaining = spawnSync(policy.docker, [...dockerArgs, "inspect", "--format", "{{.Id}}", containerId!],
        { encoding: "utf8", timeout: 2_000, env: dockerEnv });
      complete = remaining.status === 1 && /No such (?:object|container)/i.test(remaining.stderr ?? "");
      if (remaining.status !== 0) break;
    }
  } else if (creation.id) {
    complete = found.status === 1 && /No such (?:object|container)/i.test(found.stderr ?? "");
  } else if (!creation.uncertain && found.status === 0 && owner !== runId) {
    complete = true;
  }
  complete &&= !creation.uncertain;
  attach?.stdin?.destroy();
  if (complete) {
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { complete = false; }
  }
  if (!complete) process.stderr.write(`Container cleanup incomplete for run ${runId}; private temp retained\n`);
  return complete;
}

let code = creation.id ? requestedCode : 125;
if (creation.id && !stopRequested) {
  attach = spawn(policy.docker, [...dockerArgs, "start", "--attach", "--interactive", creation.id],
    { stdio: ["pipe", "pipe", "pipe"], env: dockerEnv });
  const closed = new Promise<number>((resolve) => {
    attach!.once("error", (error) => { process.stderr.write(`${error.message}\n`); resolve(1); });
    attach!.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  attach.stdin!.on("error", () => {});
  attach.stdin!.on("drain", () => process.stdin.resume());
  attach.stdout!.pipe(process.stdout, { end: false });
  attach.stderr!.pipe(process.stderr, { end: false });
  for (const chunk of buffered) if (!attach.stdin!.write(chunk)) process.stdin.pause();
  buffered = []; bufferedBytes = 0;
  code = await Promise.race([closed, stopped.then(() => requestedCode)]);
}
const complete = cleanup();
cleanupConfirmed = complete;
clearInterval(parentWatch);
process.exit(complete ? code : 70);
