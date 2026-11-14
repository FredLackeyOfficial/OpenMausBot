import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, chmodSync, mkdtempSync, rmSync, chownSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "./control-omb.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const auth = process.env.OMB_CONTAINER_AUTH_FILE;
if (!auth) throw new Error("Set OMB_CONTAINER_AUTH_FILE to an explicitly selected Codex auth.json for the live proof");
const dockerCommand = process.env.OMB_DOCKER ?? "docker";
const dockerCandidates = dockerCommand.includes("/") ? [resolve(dockerCommand)]
  : (process.env.PATH ?? "").split(delimiter).map(directory => resolve(directory, dockerCommand));
const docker = dockerCandidates.find(candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!docker) throw new Error(`Docker executable not found: ${dockerCommand}`);
const dockerConfig = process.env.OMB_DOCKER_CONFIG;
const dockerBase = dockerConfig ? ["--config", dockerConfig] : [];
const dockerRun = (...args: string[]) => execFileSync(docker, [...dockerBase, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
const selectedImage = process.env.OMB_WORKER_IMAGE;
if (!selectedImage) throw new Error("Set OMB_WORKER_IMAGE to a built generic worker image containing the selected Codex CLI; the old CLI-only prototype image is incompatible");
const image = dockerRun("image", "inspect", "--format", "{{.Id}}", selectedImage);
const workerRoot = realpathSync(mkdtempSync(join(tmpdir(), "omb-live-workers-")));
const workerUser = process.platform === "linux" && process.getuid?.() ? `${process.getuid()}:${process.getgid!()}` : "1000:1000";
const own = (path: string) => {
  if (process.platform === "linux" && process.getuid?.() === 0) {
    chownSync(path, 1000, 1000);
    for (const child of readdirSync(path, { withFileTypes: true })) {
      const nested = join(path, child.name);
      if (child.isDirectory()) own(nested); else chownSync(nested, 1000, 1000);
    }
  }
};
const fixture = await launchVerificationServer();
const { url, logPath } = fixture.info;
const dataDir = realpathSync(fixture.info.dataDir);
const policyPath = join(dataDir, "container-workers.json");
const policyFilter = `label=org.openmausbot.policy=${createHash("sha256").update(policyPath).digest("hex")}`;
const evidence: unknown[] = [];
let child: ChildProcess = fixture.child;
const networks: string[] = [];
const botIds: string[] = [];
let ownerToken: string | undefined;
const previousToken = process.env.OPENMAUSBOT_TOKEN;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as any;
  assert.equal(response.status < 300, true, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
};
const control = async (...args: string[]) => {
  const result = await runControlOmb([...args, "--url", url]) as any;
  evidence.push({ command: args, result });
  return result;
};
const poll = async (check: () => boolean | Promise<boolean>, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error("Proof condition timed out");
};
const restart = async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  const log = openSync(logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../server/index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
  });
  closeSync(log);
  await poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } });
};
let passed = false;
try {
  const chief = (await control("new-bot", "--name", "Container Chief", "--section", "Container proof")).bot;
  const specialist = (await control("new-bot", "--name", "Container Specialist", "--section", "Container proof")).bot;
  botIds.push(chief.id, specialist.id);
  await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["client", "admin"] });
  ownerToken = (await api("POST", "/api/auth/pair", { code: pairing.code, label: "Container proof operator" })).token;
  assert.ok(ownerToken);
  process.env.OPENMAUSBOT_TOKEN = ownerToken;
  await waitForExit(child, { signal: "SIGTERM" });
  const workers: Record<string, any> = {};
  for (const [index, bot] of [chief, specialist].entries()) {
    const root = join(workerRoot, bot.id);
    const home = join(root, "home"), temp = join(root, "tmp");
    const workspaces = [join(root, "work"), join(root, "tasks")];
    for (const path of [join(home, ".codex"), temp, ...workspaces]) mkdirSync(path, { recursive: true, mode: 0o700 });
    copyFileSync(auth, join(home, ".codex", "auth.json"));
    chmodSync(join(home, ".codex", "auth.json"), 0o600);
    writeFileSync(join(home, "private-canary"), `private-${bot.id}`);
    const network = `omb-proof-${randomUUID()}`;
    dockerRun("network", "create", "--label", "org.openmausbot.proof=true", network);
    networks.push(network);
    workers[bot.id] = { instanceId: `container-${index}`, image, home, temp, workspaces, network, user: workerUser };
  }
  writeFileSync(policyPath, JSON.stringify({ docker, dockerConfig, workers }, null, 2), { mode: 0o600 });
  const configPath = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances = Object.fromEntries(Object.values(workers).map((worker: any) => [worker.instanceId, { driver: "codex", displayName: worker.instanceId, config: {} }]));
  writeFileSync(configPath, JSON.stringify(config));
  const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  for (const bot of saved) {
    if (!workers[bot.id]) continue;
    bot.modelSelection = { instanceId: workers[bot.id].instanceId, model: process.env.OMB_CONTAINER_MODEL ?? "gpt-6.1-sol" };
    bot.approvalMode = "full";
    bot.cwd = workers[bot.id].workspaces[0];
    bot.soul = "Run only the specific verification requested. Keep replies concise. Use coordinate_bots for delegation.";
    for (const task of bot.tasks) { task.modelSelection = bot.modelSelection; task.approvalMode = "full"; task.cwd = join(workers[bot.id].workspaces[1], task.threadId); mkdirSync(task.cwd, { recursive: true }); }
  }
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved));
  const specialistWork = join(workers[specialist.id].workspaces[1], specialist.activeTaskId);
  mkdirSync(specialistWork, { recursive: true });
  const probePath = join(specialistWork, "probe.cjs");
  const output = join(specialistWork, "proof.json");
  writeFileSync(probePath, `const fs=require('node:fs'), assert=require('node:assert/strict'), os=require('node:os'), http=require('node:http');
const forbidden=${JSON.stringify([join(workers[chief.id].home, "private-canary"), policyPath, "/var/run/docker.sock", auth])};
for(const p of forbidden) assert.equal(fs.existsSync(p),false,p);
assert.equal(os.homedir(),'/home/agent'); assert.equal(os.tmpdir(),'/tmp'); assert.notEqual(process.getuid(),0);
fs.writeFileSync('/home/agent/home-proof','home'); fs.writeFileSync('/tmp/temp-proof','temp');
const old=fs.existsSync(${JSON.stringify(output)})?JSON.parse(fs.readFileSync(${JSON.stringify(output)})):{};
function finish(adminStatus){fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({count:(old.count||0)+1,uid:process.getuid(),home:os.homedir(),temp:os.tmpdir(),forbiddenBlocked:true,hostname:os.hostname(),adminStatus,adminBlocked:true}));console.log('CONTAINER_PROOF_OK');}
const request=http.get({hostname:'host.docker.internal',port:${Number(new URL(url).port)},path:'/api/bots',headers:{host:'127.0.0.1:${Number(new URL(url).port)}'}},response=>{assert.ok(response.statusCode>=400,'Coordinator admin API exposed to worker');response.resume();finish(response.statusCode);});
request.setTimeout(3000,()=>request.destroy(new Error('timeout')));request.on('error',()=>finish('unreachable'));`);
  own(workerRoot);
  await restart();
  console.info(JSON.stringify({ stage: "launched", url, logPath, dataDir }));
  const direct = await control("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text", `Run exactly: node ${probePath} . Report its output. Do not edit the script.`);
  assert.equal(direct.success, true);
  const settled = await control("wait", "--bot", specialist.id, "--task", specialist.activeTaskId, "--timeout", "180");
  assert.equal(settled.status, "settled");
  console.info(JSON.stringify({ stage: "first-turn", status: settled.status }));
  evidence.push(await control("messages", "--bot", specialist.id, "--task", specialist.activeTaskId, "--limit", "15"));
  assert.equal(existsSync(output), true, "The real Codex engine must execute the probe");
  assert.equal(JSON.parse(readFileSync(output, "utf8")).count, 1);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).adminBlocked, true);
  evidence.push({ stage: "filesystem", result: JSON.parse(readFileSync(output, "utf8")) });
  await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text",
    `Use coordinate_bots to ask bot ${specialist.id} to run exactly node ${probePath} and return the output. Delegate the work; do not run the command yourself. Once its result returns, report CONTAINER_DELEGATION_OK if it reported CONTAINER_PROOF_OK.`);
  await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "240");
  const chiefMessages = await control("messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "30");
  const chiefReply = chiefMessages.messages.findLast((message: any) => message.role === "bot" && message.kind === "text")?.text;
  assert.equal(chiefReply?.trim(), "CONTAINER_DELEGATION_OK");
  assert.equal(JSON.parse(readFileSync(output, "utf8")).count, 2);
  console.info(JSON.stringify({ stage: "delegation-passed" }));
  await restart();
  await control("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text", `Run node ${probePath} again. Report CONTAINER_RESTART_OK after it succeeds.`);
  await control("wait", "--bot", specialist.id, "--task", specialist.activeTaskId, "--timeout", "180");
  assert.equal(JSON.parse(readFileSync(output, "utf8")).count, 3);
  evidence.push(await control("messages", "--bot", specialist.id, "--task", specialist.activeTaskId, "--limit", "15"));
  console.info(JSON.stringify({ stage: "restart-passed" }));
  const heartbeat = join(workers[specialist.id].home, "live-heartbeat");
  const longScript = join(specialistWork, "long.cjs");
  writeFileSync(longScript, "const {spawn}=require('node:child_process');spawn('node',['-e',\"const fs=require('fs');setInterval(()=>fs.writeFileSync('/home/agent/live-heartbeat',String(Date.now())),100)\"],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);");
  await control("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text", `Run node ${longScript} in the foreground. It deliberately waits forever for a Stop test; keep it running and do not change it.`);
  await poll(() => existsSync(heartbeat), 120_000);
  await control("interrupt", "--bot", specialist.id, "--task", specialist.activeTaskId);
  await poll(() => dockerRun("ps", "-q", "--filter", policyFilter, "--filter", `label=org.openmausbot.bot=${specialist.id}`) === "", 30_000);
  assert.equal(dockerRun("ps", "-q", "--filter", policyFilter, "--filter", `label=org.openmausbot.bot=${specialist.id}`), "", "Docker confirms the worker and its descendants have terminated");
  evidence.push({ stage: "stop", heartbeatStopped: true, workerContainersRemaining: 0 });
  console.info(JSON.stringify({ stage: "stop-passed" }));
  await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, { approvalMode: "ask" });
  await control("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text",
    "Approval test: use your shell tool with sandbox_permissions=require_escalated to run exactly: printf approved > /home/agent/approval-proof . Request permission before executing. If denied, stop and report DENIED without trying another approach.");
  let card: any;
  await poll(async () => {
    const messages = (await api("GET", `/api/threads/${specialist.activeTaskId}/messages`)).messages;
    card = messages.findLast((message: any) => message.card?.requestId && !message.card?.resolved && message.card?.status !== "resolved");
    return Boolean(card);
  }, 120_000);
  assert.equal(existsSync(join(workers[specialist.id].home, "approval-proof")), false);
  const denied = await api("POST", `/api/threads/${specialist.activeTaskId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  await control("wait", "--bot", specialist.id, "--task", specialist.activeTaskId, "--timeout", "120");
  assert.equal(existsSync(join(workers[specialist.id].home, "approval-proof")), false);
  evidence.push({ stage: "approval-denied", requestId: card.card.requestId, result: denied, fileAbsent: true });
  console.info(JSON.stringify({ stage: "denied-approval-passed" }));
  passed = true;
} finally {
  await waitForExit(child, { signal: "SIGTERM" });
  for (const botId of botIds) {
    const ids = dockerRun("ps", "-aq", "--filter", policyFilter, "--filter", `label=org.openmausbot.bot=${botId}`).split(/\s+/).filter(Boolean);
    if (ids.length) dockerRun("rm", "-f", ...ids);
  }
  for (const network of networks) dockerRun("network", "rm", network);
  const evidencePath = `${logPath}.container-workers.json`;
  writeFileSync(evidencePath, JSON.stringify({ passed, image, evidence }, null, 2));
  await fixture.close();
  rmSync(workerRoot, { recursive: true, force: true });
  if (previousToken === undefined) delete process.env.OPENMAUSBOT_TOKEN; else process.env.OPENMAUSBOT_TOKEN = previousToken;
  console.info(JSON.stringify({ passed, evidencePath, logPath, fixtureRemoved: !existsSync(dataDir) }));
}
