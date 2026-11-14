import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { waitForExit } from "../testing/cleanup.ts";
import { createContainerProvider } from "./provider.ts";
import { spawnContainerWorker } from "./transport.ts";

it.skipIf(process.platform === "win32" || process.env.OMB_DOCKER_TEST !== "1")("runs the bundled provider in actual Docker with isolated files, concurrency, restart and descendant cleanup", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-docker-proof-")));
  const workerUid = process.platform === "linux" && process.getuid?.() ? process.getuid!() : 1000;
  const workerGid = process.platform === "linux" && process.getuid?.() ? process.getgid!() : 1000;
  const workerUser = `${workerUid}:${workerGid}`;
  const docker = process.env.OMB_DOCKER ?? "/usr/bin/docker";
  const dockerConfig = process.env.OMB_DOCKER_CONFIG;
  const dockerBase = dockerConfig ? ["--config", dockerConfig] : [];
  const image = process.env.OMB_WORKER_IMAGE ?? "omb-container-runtime:fixture";
  const run = (...args: string[]) => execFileSync(docker, [...dockerBase, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
  const workers: Record<string, { instanceId: string; image: string; user: string; home: string; temp: string; workspaces: string[] }> = {};
  const children: ChildProcessWithoutNullStreams[] = [];
  const instances: ProviderInstance[] = [];
  const evidence: unknown[] = [];
  let diagnostics = "";
  const previousSecret = process.env.TEST_OPERATOR_SECRET;
  process.env.TEST_OPERATOR_SECRET = "synthetic-operator-secret-do-not-forward";
  mkdirSync(join(root, "coordinator"));
  const policyPath = join(root, "coordinator", "policy.json");
  const packagedLauncher = join(root, "supervisor.mjs");
  copyFileSync(fileURLToPath(new URL("../../dist-server/container-workers/launcher.js", import.meta.url)), packagedLauncher);
  const policyFilter = `label=org.openmausbot.policy=${createHash("sha256").update(policyPath).digest("hex")}`;
  try {
    for (const bot of ["alice", "bob"]) {
      const home = join(root, bot, "home"), temp = join(root, bot, "tmp"), work = join(root, bot, "work");
      for (const path of [home, temp, work]) {
        mkdirSync(path, { recursive: true });
        if (process.platform === "linux" && process.getuid?.() === 0) chownSync(path, workerUid, workerGid);
      }
      workers[bot] = { instanceId: bot, image, user: workerUser, home, temp, workspaces: [work] };
      writeFileSync(join(home, "canary"), bot);
    }
    writeFileSync(policyPath, JSON.stringify({ docker, dockerConfig, workers }));
    const fake = readFileSync(fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url)), "utf8").replace(/^#![^\n]*\n/, "");
    for (const bot of ["alice", "bob"]) {
      const other = bot === "alice" ? "bob" : "alice";
      const worker = workers[bot];
      const cli = join(worker.workspaces[0], "fixture-acp.ts");
      writeFileSync(cli, `#!/usr/bin/env node
import * as fixtureFs from 'node:fs';
process.env.FAKE_ACP_HANG_ON="fixture-hang";
process.env.FAKE_ACP_RPC_APPEND_FILE=${JSON.stringify(join(worker.workspaces[0], "calls.jsonl"))};
if(process.argv.length===2){
const fixtureRead=(path)=>{try{fixtureFs.readFileSync(path);return true;}catch{return false;}};
const fixtureWrite=(path)=>{try{fixtureFs.writeFileSync(path,"forbidden");return true;}catch{return false;}};
const report={uid:process.getuid!(),home:process.env.HOME,temp:process.env.TMPDIR,data:process.env.OMB_DATA_DIR,
siblingRead:fixtureRead(${JSON.stringify(join(workers[other].home,"canary"))}),siblingWrite:fixtureWrite(${JSON.stringify(join(workers[other].home,"forbidden"))}),
rootWrite:fixtureWrite("/opt/omb/runtime/forbidden"),
coordinatorRead:fixtureRead(${JSON.stringify(policyPath)}),coordinatorWrite:fixtureWrite(${JSON.stringify(join(root,"coordinator","forbidden"))}),
source:fixtureFs.existsSync(${JSON.stringify(fileURLToPath(new URL("../contracts.ts", import.meta.url)))}),
other:fixtureFs.existsSync(${JSON.stringify(workers[other].home)}),policy:fixtureFs.existsSync(${JSON.stringify(policyPath)}),
docker:fixtureFs.existsSync('/var/run/docker.sock'),hostProc:fixtureFs.readFileSync('/proc/1/cmdline','utf8'),
bundle:fixtureFs.existsSync('/opt/omb/runtime/container-worker.js'),modules:fixtureFs.existsSync('/opt/omb/runtime/node_modules'),
operatorSecret:process.env.TEST_OPERATOR_SECRET??null};
const count=fixtureFs.existsSync('/home/agent/count')?Number(fixtureFs.readFileSync('/home/agent/count')):0;
fixtureFs.writeFileSync('/home/agent/count',String(count+1));fixtureFs.writeFileSync('/tmp/temp-canary','yes');
fixtureFs.writeFileSync(${JSON.stringify(join(worker.workspaces[0], "report.json"))},JSON.stringify(report));
const fixtureChild=(await import('node:child_process')).spawn('node',['-e',"const fs=require('fs');setInterval(()=>fs.writeFileSync('/home/agent/heartbeat',String(Date.now())),20)"],{detached:true,stdio:'ignore'});fixtureChild.unref();
}
${fake}`);
      chmodSync(cli, 0o755);
    }
    const start = async (bot: string) => {
      let child!: ChildProcessWithoutNullStreams;
      const instance = await createContainerProvider({ botId: bot, driverKind: "customAcp", input: {
        instanceId: bot, displayName: "Docker fixture", enabled: true,
        environment: {},
        config: { cli: join(workers[bot].workspaces[0], "fixture-acp.ts"), fullAuto: false },
      }, spawn: () => {
        child = bot === "bob"
          ? spawn(process.execPath, [packagedLauncher, policyPath, bot], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME } })
          : spawnContainerWorker(policyPath, bot);
        child.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000); });
        children.push(child); return child;
      } });
      instances.push(instance);
      const recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({ botId: bot, threadId: "fixture-thread", text: "probe", cwd: workers[bot].workspaces[0] });
      await recorder.until(event => event.type === "turn.completed", 30_000);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
      expect(recorder.events.some(event => event.type === "item.completed" && "text" in event && event.text === "hello from fake acp")).toBe(true);
      recorder.stop();
      return { child, instance };
    };
    const [a, b] = await Promise.all([start("alice"), start("bob")]);
    for (const bot of ["alice", "bob"]) {
      const worker = workers[bot];
      const report = JSON.parse(readFileSync(join(worker.workspaces[0], "report.json"), "utf8"));
      expect(report).toMatchObject({ uid: workerUid, home: "/home/agent", temp: "/tmp", data: "/home/agent/.openmausbot", other: false, policy: false, docker: false, bundle: true, modules: false, operatorSecret: null, siblingRead: false, siblingWrite: false, coordinatorRead: false, coordinatorWrite: false, source: false, rootWrite: false });
      expect(report.hostProc).toContain("docker-init");
      const generations = readdirSync(worker.temp).filter(name => name.startsWith("omb-run-"));
      expect(generations).toHaveLength(1);
      expect(readFileSync(join(worker.temp, generations[0], "temp-canary"), "utf8")).toBe("yes");
      expect(existsSync(join(worker.home, "forbidden"))).toBe(false);
      expect(existsSync(join(root, "coordinator", "forbidden"))).toBe(false);
      await expect.poll(() => existsSync(join(worker.home, "heartbeat")), { timeout: 10_000 }).toBe(true);
      const container = run("ps", "-q", "--filter", policyFilter, "--filter", `label=org.openmausbot.bot=${bot}`);
      const settings = JSON.parse(run("inspect", "--format", '{"user":{{json .Config.User}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}', container));
      expect(settings.user).toBe(workerUser);
      expect(settings.host).toMatchObject({ ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
        SecurityOpt: ["no-new-privileges"], NetworkMode: "none", PidsLimit: 128, Memory: 1073741824,
        NanoCpus: 1000000000, PidMode: "", IpcMode: "private", UTSMode: "" });
      expect(settings.host.Tmpfs).toEqual({ "/run/omb": `rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=${workerUid},gid=${workerGid}` });
      expect(settings.host.Devices ?? []).toEqual([]);
      expect(settings.host.DeviceRequests ?? []).toEqual([]);
      expect(settings.mounts.filter((mount: { Type: string }) => mount.Type === "bind").map((mount: { Source: string; Destination: string; RW: boolean }) => ({ source: mount.Source, destination: mount.Destination, writable: mount.RW })).sort((a: { destination: string }, b: { destination: string }) => a.destination.localeCompare(b.destination))).toEqual([
        { source: worker.home, destination: "/home/agent", writable: true },
        { source: join(worker.temp, generations[0]), destination: "/tmp", writable: true },
        { source: worker.workspaces[0], destination: worker.workspaces[0], writable: true },
      ].sort((a, b) => a.destination.localeCompare(b.destination)));
      expect(settings.mounts.filter((mount: { Type: string }) => mount.Type !== "bind").every((mount: { Type: string; Destination: string }) => mount.Type === "tmpfs" && mount.Destination === "/run/omb")).toBe(true);
      evidence.push({ bot, driverKind: "customAcp", simulatedClient: true, report,
        hardening: { user: settings.user, readOnlyRoot: settings.host.ReadonlyRootfs, capDrop: settings.host.CapDrop,
          securityOptions: settings.host.SecurityOpt, network: settings.host.NetworkMode, pids: settings.host.PidsLimit,
          memoryBytes: settings.host.Memory, nanoCpus: settings.host.NanoCpus, exactPrivateMounts: true, privateIpcTmpfs: settings.host.Tmpfs } });
    }
    const duplicate = spawnContainerWorker(policyPath, "alice");
    children.push(duplicate);
    duplicate.stderr.resume();
    await expect.poll(() => duplicate.exitCode, { timeout: 15_000 }).toBe(125);
    expect(a.child.exitCode).toBeNull();
    expect(run("ps", "-q", "--filter", policyFilter).split(/\s+/)).toHaveLength(2);
    const stopEvents = recordEvents(a.instance.adapter);
    const hanging = await a.instance.adapter.sendTurn({ botId: "alice", threadId: "fixture-thread", text: "fixture-hang", cwd: workers.alice.workspaces[0] });
    await expect.poll(() => readFileSync(join(workers.alice.workspaces[0], "calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"session/prompt"')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await a.instance.adapter.interruptTurn("fixture-thread", hanging.turnId);
    await expect.poll(() => run("ps", "-q", "--filter", policyFilter, "--filter", "label=org.openmausbot.bot=alice"), { timeout: 15_000 }).toBe("");
    expect(b.child.exitCode).toBeNull();
    const resumed = await a.instance.adapter.sendTurn({ botId: "alice", threadId: "fixture-thread", text: "probe after Stop", cwd: workers.alice.workspaces[0] });
    expect(await stopEvents.until(event => event.type === "turn.completed" && event.turnId === resumed.turnId, 30_000)).toMatchObject({ ok: true });
    stopEvents.stop();
    await a.instance.dispose();
    await waitForExit(a.child);
    await waitForExit(b.child, { signal: "SIGKILL" });
    await expect.poll(() => run("ps", "-q", "--filter", policyFilter), { timeout: 15_000 }).toBe("");
    const heartbeat = readFileSync(join(workers.bob.home, "heartbeat"), "utf8");
    const previousCount = Number(readFileSync(join(workers.alice.home, "count"), "utf8"));
    const restarted = await start("alice");
    expect(Number(readFileSync(join(workers.alice.home, "count"), "utf8"))).toBeGreaterThan(previousCount);
    expect(readFileSync(join(workers.bob.home, "heartbeat"), "utf8")).toBe(heartbeat);
    await restarted.instance.dispose();
    await waitForExit(restarted.child);
    await expect.poll(() => run("ps", "-q", "--filter", policyFilter), { timeout: 15_000 }).toBe("");
    const result = { dockerIsolation: evidence, imageId: run("image", "inspect", "--format", "{{.Id}}", image),
      platform: run("info", "--format", "{{.OperatingSystem}}/{{.Architecture}}"),
      packagedWorker: true, packagedSupervisor: true, realAgentClient: false, liveProvider: false, duplicateLaunchPreservedOwner: true,
      gracefulStop: true, stopRemovesWorker: true, nextTurnAfterStop: true, supervisorKilledDescendantsStopped: true, restartPersisted: true };
    const directory = fileURLToPath(new URL("../../.omb-scratch/verify-evidence/container-workers/", import.meta.url));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "docker-provider-isolation.json"), JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(diagnostics, children.map(child => ({ pid: child.pid, code: child.exitCode, signal: child.signalCode })));
    throw error;
  } finally {
    if (previousSecret === undefined) delete process.env.TEST_OPERATOR_SECRET; else process.env.TEST_OPERATOR_SECRET = previousSecret;
    for (const instance of instances) await instance.dispose().catch(() => {});
    for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
    const remaining = run("ps", "-aq", "--filter", policyFilter).split(/\s+/).filter(Boolean);
    if (remaining.length) run("rm", "-f", ...remaining);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
