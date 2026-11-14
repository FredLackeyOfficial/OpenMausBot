import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";

it.skipIf(process.env.OMB_DOCKER_TEST !== "1")("isolates actual Docker workers and kills orphaned descendants on graceful stop and launcher death", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-docker-proof-")));
  const docker = process.env.OMB_DOCKER ?? "/usr/local/bin/docker";
  const dockerConfig = process.env.OMB_DOCKER_CONFIG;
  const dockerBase = dockerConfig ? ["--config", dockerConfig] : [];
  const run = (...args: string[]) => execFileSync(docker, [...dockerBase, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
  const workers: Record<string, any> = {};
  const children: ChildProcess[] = [];
  const evidence: unknown[] = [];
  const policyPath = join(root, "policy.json");
  const policyFilter = `label=org.openmausbot.policy=${createHash("sha256").update(policyPath).digest("hex")}`;
  try {
    for (const bot of ["alice", "bob"]) {
      const home = join(root, bot, "home"), temp = join(root, bot, "tmp"), work = join(root, bot, "work");
      for (const path of [home, temp, work]) mkdirSync(path, { recursive: true });
      workers[bot] = { instanceId: bot, image: "omb-container-codex:0.169.0", command: ["node", join(work, "probe.mjs")], home, temp, workspaces: [work] };
      writeFileSync(join(home, "canary"), bot);
    }
    const policy = policyPath;
    writeFileSync(policy, JSON.stringify({ docker, dockerConfig, workers }));
    for (const bot of ["alice", "bob"]) {
      const other = bot === "alice" ? "bob" : "alice";
      const worker = workers[bot];
      writeFileSync(join(worker.workspaces[0], "probe.mjs"), `
import {spawn} from 'node:child_process'; import * as fs from 'node:fs'; import os from 'node:os';
const report={uid:process.getuid(),home:os.homedir(),temp:os.tmpdir(),other:fs.existsSync(${JSON.stringify(workers[other].home)}),policy:fs.existsSync(${JSON.stringify(policy)}),docker:fs.existsSync('/var/run/docker.sock'),hostProc:fs.readFileSync('/proc/1/cmdline','utf8')};
const count=fs.existsSync('/home/agent/count')?Number(fs.readFileSync('/home/agent/count')):0;
fs.writeFileSync('/home/agent/count',String(count+1));fs.writeFileSync('/tmp/temp-canary','yes');
fs.writeFileSync(${JSON.stringify(join(worker.workspaces[0], "report.json"))},JSON.stringify(report));
spawn('node',['-e',"const fs=require('fs');setInterval(()=>fs.writeFileSync('/home/agent/heartbeat',String(Date.now())),100)"],{detached:true,stdio:'ignore'}).unref();
setInterval(()=>{},1000);`);
    }
    const start = (bot: string) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./launcher.ts", import.meta.url)), policy, bot, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
      let errors = ""; child.stderr?.on("data", chunk => { errors += chunk; });
      children.push(child);
      return { child, errors: () => errors };
    };
    const a = start("alice"), b = start("bob");
    for (const bot of ["alice", "bob"]) {
      const worker = workers[bot];
      const reportPath = join(worker.workspaces[0], "report.json");
      await expect.poll(() => existsSync(reportPath) || a.errors() || b.errors(), { timeout: 30_000 }).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report).toMatchObject({ uid: 1000, home: "/home/agent", temp: "/tmp", other: false, policy: false, docker: false });
      expect(report.hostProc).toContain("docker-init");
      expect(readFileSync(join(worker.temp, "temp-canary"), "utf8")).toBe("yes");
      await expect.poll(() => existsSync(join(worker.home, "heartbeat")), { timeout: 10_000 }).toBe(true);
      evidence.push({ bot, report });
    }
    const duplicate = start("alice");
    await expect.poll(() => duplicate.child.exitCode, { timeout: 15_000 }).toBe(125);
    expect(a.child.exitCode).toBeNull();
    expect(run("ps", "-q", "--filter", policyFilter).split(/\s+/)).toHaveLength(2);
    await waitForExit(a.child, { signal: "SIGTERM" });
    await waitForExit(b.child, { signal: "SIGKILL" });
    await expect.poll(() => run("ps", "-q", "--filter", policyFilter), { timeout: 15_000 }).toBe("");
    const heartbeats = ["alice", "bob"].map(bot => readFileSync(join(workers[bot].home, "heartbeat"), "utf8"));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(["alice", "bob"].map(bot => readFileSync(join(workers[bot].home, "heartbeat"), "utf8"))).toEqual(heartbeats);
    const restarted = start("alice");
    await expect.poll(() => readFileSync(join(workers.alice.home, "count"), "utf8"), { timeout: 30_000 }).toBe("2");
    await waitForExit(restarted.child, { signal: "SIGTERM" });
    const report = { dockerIsolation: evidence, duplicateLaunchDidNotStopExistingWorker: true, gracefulStop: true, launcherKilledDescendantsStopped: true, restartPersisted: true };
    const evidenceDirectory = fileURLToPath(new URL("../../.omb-scratch/verify-evidence/container-workers/", import.meta.url));
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, "docker-isolation.json"), JSON.stringify(report, null, 2));
    console.info(JSON.stringify(report));
  } finally {
    for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
    for (const bot of ["alice", "bob"]) {
      const remaining = run("ps", "-aq", "--filter", policyFilter, "--filter", `label=org.openmausbot.bot=${bot}`).split(/\s+/).filter(Boolean);
      if (remaining.length) run("rm", "-f", ...remaining);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
