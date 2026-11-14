import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContainerWorkers, readWorkerPolicy, validateWorkerEnvironment } from "./policy.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { createContainerProvider } from "./provider.ts";

vi.mock("./provider.ts", () => ({ createContainerProvider: vi.fn() }));
beforeEach(() => {
  vi.mocked(createContainerProvider).mockImplementation(async (options) => {
    const fake = makeFakeDriver({ kind: options.driverKind });
    const instance = await fake.driver.create({ ...options.input, config: {} });
    const send = instance.adapter.sendTurn;
    instance.adapter.sendTurn = async (turn) => { options.validateTurn?.(turn); return send(turn); };
    return instance;
  });
});

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-worker-policy-")));
  roots.push(root);
  const workers = Object.fromEntries(["alice", "bob"].map((id) => {
    const paths = ["home", "temp", "work"].map((part) => join(root, id, part));
    paths.forEach((path) => mkdirSync(path, { recursive: true }));
    return [id, { instanceId: id, image: "test", command: ["codex"], home: paths[0]!, temp: paths[1]!, workspaces: [paths[2]!] }];
  }));
  mkdirSync(join(root, "coordinator"));
  const path = join(root, "coordinator", "policy.json");
  const save = () => writeFileSync(path, JSON.stringify({ workers }));
  save();
  return { root, path, workers, save };
}
it("refuses overlapping mounts, symlink roots, shared engine identities, and policy exposure", () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.home = f.workers.alice!.home; },
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.instanceId = "alice"; },
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.home = f.root; },
    (f: ReturnType<typeof fixture>) => { const link = join(f.root, "link"); symlinkSync(f.workers.bob!.home, link, process.platform === "win32" ? "junction" : "dir"); f.workers.bob!.home = link; },
  ]) {
    const f = fixture(); mutation(f); f.save();
    expect(() => readWorkerPolicy(f.path)).toThrow();
  }
});
it("blocks uncontained engines and wrong-bot selections through the actual registry", async () => {
  const f = fixture();
  const fake = makeFakeDriver({ kind: "codex" });
  const registry = new ProviderRegistry([fake.driver], { containerWorkers: new ContainerWorkers(f.path) });
  await registry.load({ alice: { driver: "codex", config: { cli: "uncontained-host-command" } }, bob: { driver: "codex" }, host: { driver: "codex" } });
  expect(registry.get("host")).toBeNull();
  expect(fake.created.has("host")).toBe(false);
  expect(JSON.stringify(fake.decodedConfigs)).not.toContain("uncontained-host-command");
  const alice = registry.get("alice")!;
  await expect(alice.adapter.sendTurn({ threadId: "thread", botId: "bob", text: "wrong", cwd: f.workers.bob!.workspaces[0] })).rejects.toThrow("assignment");
  await expect(alice.adapter.sendTurn({ threadId: "thread", botId: "alice", text: "wrong", cwd: f.workers.bob!.workspaces[0] })).rejects.toThrow("working directory");
  await expect(alice.adapter.sendTurn({ threadId: "thread", botId: "alice", text: "right", cwd: f.workers.alice!.workspaces[0] })).resolves.toBeDefined();
  expect(alice.generateText).toBeUndefined();
  expect(alice.generateMemoryText).toBeUndefined();
  expect(fake.created.size).toBe(0);
  expect(fake.decodedConfigs).toEqual([]);
  await registry.dispose("alice"); await registry.dispose("bob");
});

it("routes every registered driver through the worker factory without host creation or config decoding", async () => {
  const f = fixture();
  const drivers = BUILT_IN_DRIVERS.map((driver) => ({ ...driver, create: vi.fn(async () => { throw new Error("Host create escaped"); }),
    decodeConfig: vi.fn(() => { throw new Error("Host config decoding escaped"); }) }));
  for (const driver of drivers) {
    const registry = new ProviderRegistry([driver], { containerWorkers: new ContainerWorkers(f.path) });
    const config = { cli: "inside-image", selected: "preserve-this" };
    await registry.load({ alice: { driver: driver.driverKind, config, environment: { TEST_PROVIDER_KEY: "selected-key" } } });
    expect(registry.get("alice")?.driverKind, driver.driverKind).toBe(driver.driverKind);
    expect(driver.create).not.toHaveBeenCalled();
    expect(driver.decodeConfig).not.toHaveBeenCalled();
    expect(createContainerProvider).toHaveBeenLastCalledWith(expect.objectContaining({ driverKind: driver.driverKind,
      input: expect.objectContaining({ config, environment: { TEST_PROVIDER_KEY: "selected-key" } }) }));
    await expect(registry.installRuntime("alice")).rejects.toThrow("assigned image");
    const [shown] = await registry.describe();
    expect(shown?.install).toBeUndefined();
    expect(shown?.cliCandidates).toEqual([]);
    await registry.dispose("alice");
  }
});

it("does not fall back to the host when a worker fails", async () => {
  const f = fixture();
  const host = makeFakeDriver({ kind: "codex" });
  vi.mocked(createContainerProvider).mockRejectedValueOnce(new Error("Worker image missing"));
  const registry = new ProviderRegistry([host.driver], { containerWorkers: new ContainerWorkers(f.path) });
  await registry.load({ alice: { driver: "codex" } });
  expect(registry.get("alice")).toBeNull();
  expect(host.created.size).toBe(0);
  expect((await registry.describe())[0]?.snapshot.reason).toContain("Worker image missing");
});

it.each(["HOME", "PATH", "node_options", "SSH_AUTH_SOCK", "OMB_COMMS_TOKEN", "DOCKER_HOST", "XDG_CONFIG_HOME", "LD_PRELOAD"])("rejects reserved environment %s", (name) => {
  expect(() => validateWorkerEnvironment({ [name]: "forbidden" })).toThrow("reserved");
});

it("validates optional turn paths without requiring output files to exist", () => {
  const f = fixture();
  const workers = new ContainerWorkers(f.path);
  const cwd = f.workers.alice!.workspaces[0]!;
  expect(() => workers.validateTurn("alice", { botId: "alice", threadId: "thread", text: "hello", cwd,
    botSettingsFile: join(cwd, ".claude", "settings.json") })).not.toThrow();
  for (const key of ["toolResultFolder", "botSettingsFile", "userSkillsDir"]) {
    expect(() => workers.validateTurn("alice", { botId: "alice", threadId: "thread", text: "hello", cwd, [key]: f.workers.bob!.workspaces[0] })).toThrow("turn path");
  }
});

it("selects the recipient's own workspace for delegation", () => {
  const f = fixture();
  const workers = new ContainerWorkers(f.path);
  expect(workers.workingDirectory("bob")).toBe(f.workers.bob!.workspaces[0]);
  expect(() => workers.workingDirectory("bob", f.workers.alice!.workspaces[0])).toThrow("recipient working directory");
  expect(() => workers.workingDirectory("unknown")).toThrow("unassigned recipient");
});

it("admits only explicitly selected namespaced provider keys", () => {
  expect(() => validateWorkerEnvironment({ OMB_OPENAI_API_KEY: "selected", OMB_OPENROUTER_API_KEY: "selected", OMB_ANTHROPIC_API_KEY: "selected" })).not.toThrow();
  expect(() => validateWorkerEnvironment({ OMB_CLOUD_ROLE: "admin" })).toThrow("reserved");
});

it("never mounts the operator's explicitly configured Docker credentials", () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ workers: f.workers, dockerConfig: f.workers.alice!.workspaces[0] }));
  expect(() => readWorkerPolicy(f.path)).toThrow("administrative");
  const linked = join(f.root, "docker-config-link");
  symlinkSync(f.workers.alice!.home, linked, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(f.path, JSON.stringify({ workers: f.workers, dockerConfig: linked }));
  expect(() => readWorkerPolicy(f.path)).toThrow("administrative");
});

it.skipIf(process.platform === "win32")("protects a policy reached through a symlink from worker writes", () => {
  const f = fixture();
  const target = join(f.workers.alice!.workspaces[0]!, "policy.json");
  writeFileSync(target, JSON.stringify({ workers: f.workers }));
  const link = join(f.root, "coordinator", "linked-policy.json");
  symlinkSync(target, link);
  expect(() => readWorkerPolicy(link)).toThrow("administrative");
});
