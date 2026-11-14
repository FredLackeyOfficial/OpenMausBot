import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(foreign = false, removalFails = false, creationDelay = 0, crashAfterStart = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-supervisor-")));
  roots.push(root);
  const record = join(root, "docker.jsonl"), docker = join(root, "docker");
  const worker = { instanceId: "bot-engine", user: process.platform === "linux" && process.getuid?.() ? `${process.getuid!()}:${process.getgid!()}` : "1000:1000", image: "fixture:1", home: join(root, "home"), temp: join(root, "temp"), workspaces: [join(root, "work")] };
  for (const path of [worker.home, worker.temp, ...worker.workspaces]) mkdirSync(path);
  writeFileSync(docker, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2); const file=${JSON.stringify(record)};
fs.appendFileSync(file,JSON.stringify({args,env:process.env})+'\\n');
if(args[0]==='create'){setTimeout(()=>{process.stdout.write('a'.repeat(64));process.exit(0);},${creationDelay});}
else if(args[0]==='start'){process.stdout.write('ready\\n');process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.exit(0));}
else if(args[0]==='rm'){process.exit(${removalFails ? 1 : 0});}
else if(args[0]==='inspect'){const run=JSON.parse(fs.readFileSync(file,'utf8').split('\\n')[0]); const label=run.args.find(a=>a.startsWith('org.openmausbot.run=')); process.stdout.write('a'.repeat(64)+' '+${foreign ? "'another-run'" : "label.split('=')[1]"});}
`);
  chmodSync(docker, 0o755);
  mkdirSync(join(root, "coordinator"));
  const policy = join(root, "coordinator", "policy.json");
  writeFileSync(policy, JSON.stringify({ docker, workers: { alice: worker } }));
  const preload = join(root, "crash.mjs");
  if (crashAfterStart) writeFileSync(preload, `import fs from 'node:fs'; setInterval(() => { if(fs.existsSync(${JSON.stringify(record)}) && fs.readFileSync(${JSON.stringify(record)},'utf8').includes('"start"')) throw new Error('synthetic unexpected supervisor failure'); },10);`);
  const child = spawn(process.execPath, [...(crashAfterStart ? ["--import", preload] : []), "--experimental-strip-types", fileURLToPath(new URL("./launcher.ts", import.meta.url)), policy, "alice"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TEST_OPERATOR_SECRET: "never-forward", DOCKER_HOST: "tcp://wrong-host.invalid" } });
  children.push(child);
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  return { child, record, worker, output: () => output, errors: () => errors };
}

// Supported coordinators use POSIX executable fixtures and graceful process signals.
describe.skipIf(process.platform === "win32")("POSIX container supervisor", () => {
it("launches only the image runtime with private mounts and forwards RPC without inheriting operator credentials", async () => {
  const f = fixture();
  await expect.poll(() => f.output() || f.errors(), { timeout: 10_000 }).toBe("ready\n");
  f.child.stdin.write('{"private":"stdin-only"}\n');
  await expect.poll(f.output).toContain('"stdin-only"');
  const first = JSON.parse(readFileSync(f.record, "utf8").split("\n")[0]);
  expect(first.env.TEST_OPERATOR_SECRET).toBeUndefined();
  expect(first.env.DOCKER_HOST).toBeUndefined();
  expect(first.args).toContain("--read-only");
  expect(first.args).toContain("XDG_RUNTIME_DIR=/run/omb");
  expect(first.args).toContain("OMB_CONTAINER_IPC_DIR=/run/omb");
  expect(first.args).toContain(`/run/omb:rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=${f.worker.user.split(":")[0]},gid=${f.worker.user.split(":")[1]}`);
  expect(first.args).toContain("--cap-drop=ALL");
  expect(first.args).toContain("--security-opt=no-new-privileges");
  expect(first.args.slice(-4)).toEqual(["--entrypoint", "node", "fixture:1", "/opt/omb/runtime/container-worker.js"]);
  expect(first.args.join(" ")).not.toContain("stdin-only");
  expect(first.args.join(" ")).not.toContain("node_modules");
  const tempMount = first.args.find((arg: string) => arg.includes(",dst=/tmp"));
  const temp = tempMount.slice("type=bind,src=".length).split(",dst=")[0];
  expect(temp.startsWith(`${f.worker.temp}/omb-run-`)).toBe(true);
  expect(existsSync(temp)).toBe(true);
  await waitForExit(f.child, { signal: "SIGTERM" });
  expect(existsSync(temp)).toBe(false);
  expect(readFileSync(f.record, "utf8")).toContain('"rm","-f"');
});

it("does not remove a container whose run label belongs to another supervisor", async () => {
  const f = fixture(true);
  await expect.poll(() => f.output() || f.errors(), { timeout: 10_000 }).toBe("ready\n");
  await waitForExit(f.child, { signal: "SIGTERM" });
  expect(readFileSync(f.record, "utf8")).not.toContain('"rm","-f"');
});

it("reports unconfirmed cleanup so the provider cannot start a replacement generation", async () => {
  const f = fixture(false, true);
  await expect.poll(() => f.output() || f.errors(), { timeout: 10_000 }).toBe("ready\n");
  await waitForExit(f.child, { signal: "SIGTERM" });
  expect(f.child.exitCode).toBe(70);
  expect(f.errors()).toContain("cleanup incomplete");
});

it("waits for cancelled creation and removes its stopped container without ever starting it", async () => {
  const f = fixture(false, false, 500);
  await expect.poll(() => existsSync(f.record), { timeout: 10_000 }).toBe(true);
  await waitForExit(f.child, { signal: "SIGTERM" });
  expect(f.child.exitCode).toBe(143);
  const calls = readFileSync(f.record, "utf8").trim().split("\n").map(line => JSON.parse(line).args[0]);
  expect(calls).toContain("create");
  expect(calls).toContain("rm");
  expect(calls).not.toContain("start");
});

it.each([false, true])("cleans up after a broken output pipe or reports uncertain cleanup (removal fails: %s)", async (removalFails) => {
  const f = fixture(false, removalFails);
  await expect.poll(() => f.output() || f.errors(), { timeout: 10_000 }).toBe("ready\n");
  f.child.stdout.destroy();
  f.child.stdin.write("trigger-output-after-reader-close\n");
  await waitForExit(f.child);
  expect(f.child.signalCode).toBeNull();
  expect(f.child.exitCode).toBe(removalFails ? 70 : 1);
  expect(readFileSync(f.record, "utf8")).toContain('"rm","-f"');
});

it("marks an unexpected supervisor exception as unconfirmed cleanup", async () => {
  const f = fixture(false, false, 0, true);
  await waitForExit(f.child);
  expect(f.child.signalCode).toBeNull();
  expect(f.child.exitCode).toBe(70);
  expect(f.errors()).toContain("synthetic unexpected supervisor failure");
});
});
