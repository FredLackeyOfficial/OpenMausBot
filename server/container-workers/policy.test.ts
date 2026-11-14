import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ContainerWorkers, readWorkerPolicy } from "./policy.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "../harness/registry.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-worker-policy-")));
  roots.push(root);
  const workers = Object.fromEntries(["alice", "bob"].map((id) => {
    const paths = ["home", "temp", "work"].map((part) => join(root, id, part));
    paths.forEach((path) => mkdirSync(path, { recursive: true }));
    return [id, { instanceId: id, image: "test", command: ["codex"], home: paths[0]!, temp: paths[1]!, workspaces: [paths[2]!] }];
  }));
  const path = join(root, "policy.json");
  const save = () => writeFileSync(path, JSON.stringify({ workers }));
  save();
  return { root, path, workers, save };
}
it("refuses overlapping mounts, symlink roots, shared engine identities, and policy exposure", () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.home = f.workers.alice!.home; },
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.instanceId = "alice"; },
    (f: ReturnType<typeof fixture>) => { f.workers.bob!.home = f.root; },
    (f: ReturnType<typeof fixture>) => { const link = join(f.root, "link"); symlinkSync(f.workers.bob!.home, link); f.workers.bob!.home = link; },
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
  expect(alice.adapter.capabilities.customMcp).toBe(false);
  await registry.dispose("alice"); await registry.dispose("bob");
});
