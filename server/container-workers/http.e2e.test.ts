import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { readHandoffs } from "../testing/handoff-rows.ts";

// This is a foreground-owned coordinator with a throwaway home, paired fixture
// session and synthetic ACP executable. It never uses a developer's running app.
it.skipIf(process.platform === "win32" || process.env.OMB_DOCKER_TEST !== "1")("authenticates the real coordinator and delegates between actual contained provider workers", async () => {
  const workerUid = process.platform === "linux" && process.getuid?.() ? process.getuid!() : 1000;
  const workerGid = process.platform === "linux" && process.getuid?.() ? process.getgid!() : 1000;
  const docker = process.env.OMB_DOCKER ?? "/usr/bin/docker";
  const dockerConfig = process.env.OMB_DOCKER_CONFIG;
  const dockerBase = dockerConfig ? ["--config", dockerConfig] : [];
  const run = (...args: string[]) => execFileSync(docker, [...dockerBase, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
  const image = run("image", "inspect", "--format", "{{.Id}}", process.env.OMB_WORKER_IMAGE ?? "omb-container-runtime:fixture");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-http-workers-")));
  const fixture = await launchVerificationServer({});
  const { url, logPath } = fixture.info;
  const dataDir = realpathSync(fixture.info.dataDir);
  const policyPath = join(dataDir, "container-workers.json");
  const policyFilter = `label=org.openmausbot.policy=${createHash("sha256").update(policyPath).digest("hex")}`;
  let child: ChildProcess = fixture.child;
  let token: string | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result: any = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(300);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url], { env: { OPENMAUSBOT_URL: url, ...(token ? { OPENMAUSBOT_TOKEN: token } : {}) } }) as Promise<any>;
  const workers: Record<string, { instanceId: string; image: string; user: string; home: string; temp: string; workspaces: string[] }> = {};
  const proof: Record<string, unknown> = { image, logPath, actualCoordinator: true, actualDocker: true, pairedOperator: false, realAgentClient: false, liveProvider: false, passed: false };
  const denied: Array<{ method: string; path: string; host: string; forwarded: boolean; status: number; error: string }> = [];
  try {
    const chief = (await control("new-bot", "--name", "Contained chief", "--section", "HTTP fixture")).bot;
    const specialist = (await control("new-bot", "--name", "Contained specialist", "--section", "HTTP fixture")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    token = (await api("POST", "/api/auth/pair", { code: pairing.code, label: "Isolated fixture operator" })).token;
    expect(token).toBeTruthy();
    proof.pairedOperator = true;
    await waitForExit(child, { signal: "SIGTERM" });
    for (const [index, bot] of [chief, specialist].entries()) {
      const home = join(root, bot.id, "home"), temp = join(root, bot.id, "tmp"), work = join(root, bot.id, "work");
      for (const path of [home, temp, work]) mkdirSync(path, { recursive: true });
      workers[bot.id] = { instanceId: `fixture-${index}`, image, user: `${workerUid}:${workerGid}`, home, temp, workspaces: [work] };
      writeFileSync(join(home, "private-canary"), bot.id);
    }
    const fake = readFileSync(fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url)), "utf8").replace(/^#![^\n]*\n/, "");
    for (const bot of [chief, specialist]) {
      const worker = workers[bot.id], other = workers[bot.id === chief.id ? specialist.id : chief.id];
      const work = worker.workspaces[0], cli = join(work, "fixture-acp.ts");
      const calls = join(work, "calls.json");
      writeFileSync(calls, JSON.stringify([{ server: "agents", name: "coordinate_bots", arguments: { bot_ids: [specialist.id], message: "Return the contained fixture result", thread: "new", reply: "none" } }]));
      writeFileSync(cli, `#!/usr/bin/env node
import * as fixtureFs from 'node:fs';
${bot.id === specialist.id ? "process.env.FAKE_ACP_TEXT_REPLY='HTTP_WORKER_OK';" : ""}
${bot.id === chief.id ? `process.env.FAKE_ACP_MODE='mcp-calls';process.env.FAKE_ACP_MCP_CALLS_FILE=${JSON.stringify(calls)};` : ""}
if(process.argv.length===2){
const readable=(p)=>{try{fixtureFs.readFileSync(p);return true;}catch{return false;}};
const count=fixtureFs.existsSync('/home/agent/count')?Number(fixtureFs.readFileSync('/home/agent/count')):0;
fixtureFs.writeFileSync('/home/agent/count',String(count+1));fixtureFs.writeFileSync('/tmp/http-marker','owned');
fixtureFs.writeFileSync(${JSON.stringify(join(work, "report.json"))},JSON.stringify({uid:process.getuid(),home:process.env.HOME,temp:process.env.TMPDIR,count:count+1,
coordinatorRead:readable(${JSON.stringify(policyPath)}),siblingRead:readable(${JSON.stringify(join(other.home, "private-canary"))}),dockerSocket:fixtureFs.existsSync('/var/run/docker.sock'),pid1:fixtureFs.readFileSync('/proc/1/cmdline','utf8')}));
}
${fake}`);
      chmodSync(cli, 0o755);
    }
    writeFileSync(policyPath, JSON.stringify({ docker, dockerConfig, workers }), { mode: 0o600 });
    const configPath = join(dataDir, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances = Object.fromEntries(Object.values(workers).map(worker => [worker.instanceId, {
      driver: "customAcp", displayName: worker.instanceId, config: { cli: join(worker.workspaces[0], "fixture-acp.ts"), fullAuto: false },
    }]));
    writeFileSync(configPath, JSON.stringify(config));
    const botsPath = join(dataDir, "bots.json"), saved = JSON.parse(readFileSync(botsPath, "utf8"));
    for (const bot of saved) {
      const worker = workers[bot.id];
      if (!worker) continue;
      bot.modelSelection = { instanceId: worker.instanceId, model: "agent-default" };
      bot.approvalMode = "full"; bot.cwd = worker.workspaces[0];
      for (const task of bot.tasks) { task.modelSelection = bot.modelSelection; task.approvalMode = "full"; task.cwd = bot.cwd; }
    }
    writeFileSync(botsPath, JSON.stringify(saved));
    if (process.platform === "linux" && process.getuid?.() === 0) {
      const own = (path: string) => { chownSync(path, workerUid, workerGid); for (const entry of readdirSync(path, { withFileTypes: true })) { const nested = join(path, entry.name); if (entry.isDirectory()) own(nested); else chownSync(nested, workerUid, workerGid); } };
      own(root);
    }
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const paths: Array<[string, string, unknown?]> = [
      ["GET", "/api/bots"], ["GET", `/api/threads/${specialist.threadId}/messages`], ["GET", "/api/attachments/other.png"],
      ["POST", `/api/bots/${specialist.id}/tasks`, { title: "Unauthorized" }],
      ["POST", `/api/bots/${specialist.id}/messages/guarded`, { text: "Unauthorized" }],
      ["POST", `/api/threads/${specialist.threadId}/respond`, { requestId: "forged", decision: "allow" }],
      ["GET", `/api/bots/${specialist.id}/requests/forged`],
      ["POST", `/api/bots/${specialist.id}/requests/forged/interrupt`, {}],
      ["DELETE", `/api/bots/${specialist.id}/queue/forged`],
      ["POST", "/api/auth/pairing", { scopes: ["admin"] }], ["PATCH", "/api/config", { instances: {} }],
      ["POST", "/api/internal/coordinate-bots", { bot_ids: [specialist.id], message: "Unauthorized" }],
    ];
    for (const { host, forwarded } of [`127.0.0.1:${new URL(url).port}`, `localhost:${new URL(url).port}`].flatMap(host => [{ host, forwarded: false }, { host, forwarded: true }])) {
      for (const [method, path, body] of paths) {
        const response = await fetch(`${url}${path}`, { method, headers: { host, ...(forwarded ? { "x-forwarded-for": "127.0.0.1" } : {}), "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const error = await response.text();
        denied.push({ method, path, host, forwarded, status: response.status, error });
        expect([401, 403], `${method} ${path} host=${host} returned ${response.status}`).toContain(response.status);
        if (!forwarded && !path.startsWith("/api/internal/")) expect(error).toContain("service routes");
      }
    }
    proof.denied = denied;
    expect((await api("GET", "/api/bots")).bots.some((bot: any) => bot.id === specialist.id)).toBe(true);
    expect((await control("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text", "Return the contained fixture result")).success).toBe(true);
    expect((await control("wait", "--bot", specialist.id, "--task", specialist.activeTaskId, "--timeout", "60")).status).toBe("settled");
    const direct = await control("messages", "--bot", specialist.id, "--task", specialist.activeTaskId, "--limit", "20");
    expect(direct.messages.some((message: any) => message.role === "bot" && message.text === "HTTP_WORKER_OK"), JSON.stringify(direct)).toBe(true);
    const report = (id: string) => JSON.parse(readFileSync(join(workers[id].workspaces[0], "report.json"), "utf8"));
    expect(report(specialist.id)).toMatchObject({ uid: 1000, home: "/home/agent", temp: "/tmp", count: 1, coordinatorRead: false, siblingRead: false, dockerSocket: false });
    expect(report(specialist.id).pid1).toContain("docker-init");
    proof.direct = direct.messages; proof.directReport = report(specialist.id);
    const callsPath = join(workers[chief.id].workspaces[0], "calls.json");
    const allowedCalls = readFileSync(callsPath, "utf8");
    const forbiddenCalls = JSON.parse(allowedCalls);
    forbiddenCalls[0].arguments.in_my_folder = true;
    const taskCount = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === specialist.id).tasks.length;
    writeFileSync(callsPath, JSON.stringify(forbiddenCalls));
    expect((await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Attempt forbidden shared-folder delegation")).success).toBe(true);
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "60")).status).toBe("failed");
    const refusedMessages = await control("messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "20");
    expect(JSON.stringify(refusedMessages)).toContain("in_my_folder cannot share");
    proof.explicitSharedFolderResult = refusedMessages.messages;
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === specialist.id).tasks).toHaveLength(taskCount);
    expect(readHandoffs(dataDir).filter(row => row.parentId && row.botId === specialist.id)).toHaveLength(0);
    expect(report(specialist.id).count).toBe(1);
    proof.explicitSharedFolderRefused = true;
    writeFileSync(callsPath, allowedCalls);
    expect((await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Delegate to the specialist")).success).toBe(true);
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "60")).status).toBe("settled");
    await expect.poll(() => { const rows = readHandoffs(dataDir); proof.handoffs = rows; return ["completed", "failed", "cancelled"].includes(rows.find(row => row.parentId && row.botId === specialist.id)?.status ?? ""); }, { timeout: 60_000 }).toBe(true);
    const handoffs = readHandoffs(dataDir);
    const handoff = handoffs.find(row => row.parentId && row.botId === specialist.id)!;
    expect(handoff.status, handoff.result).toBe("completed");
    const delegated = await api("GET", `/api/threads/${handoff.threadId}/messages`);
    expect(delegated.messages.some((message: any) => message.role === "bot" && message.text === "HTTP_WORKER_OK")).toBe(true);
    expect(report(specialist.id).count).toBeGreaterThanOrEqual(2);
    const ids = run("ps", "-q", "--filter", policyFilter).split(/\s+/).filter(Boolean);
    expect(ids).toHaveLength(2);
    const inspections = ids.map(id => JSON.parse(run("inspect", id))[0]).map(item => ({ id: item.Id, user: item.Config.User, readonlyRoot: item.HostConfig.ReadonlyRootfs, network: item.HostConfig.NetworkMode, mounts: item.Mounts.map((mount: any) => ({ source: mount.Source, target: mount.Destination })) }));
    for (const inspect of inspections) expect(inspect).toMatchObject({ user: "1000:1000", readonlyRoot: true, network: "none" });
    Object.assign(proof, { passed: true, delegated: delegated.messages, handoffs, reports: [report(chief.id), report(specialist.id)], inspections });
  } finally {
    const evidence = fileURLToPath(new URL("../../.omb-scratch/verify-evidence/container-workers", import.meta.url));
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "http-coordinator.json"), JSON.stringify({ at: new Date().toISOString(), ...proof }, null, 2));
    await waitForExit(child, { signal: "SIGTERM", graceMs: 15_000 });
    const ids = run("ps", "-aq", "--filter", policyFilter).split(/\s+/).filter(Boolean);
    if (ids.length) {
      try { run("rm", "-f", ...ids); } catch { /* --rm may already be removing the owned containers. */ }
      await expect.poll(() => run("ps", "-aq", "--filter", policyFilter), { timeout: 15_000 }).toBe("");
    }
    await fixture.close();
    await removeTempDir(root);
  }
}, 180_000);
