import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkerPolicy } from "./policy.ts";

const virtualDirectories = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const directoryStat = fs.statSync(tmpdir());
  return { ...fs,
    realpathSync: (path: string, ...options: unknown[]) => virtualDirectories.has(path) ? path : Reflect.apply(fs.realpathSync, fs, [path, ...options]),
    statSync: (path: string, ...options: unknown[]) => virtualDirectories.has(path) ? directoryStat : Reflect.apply(fs.statSync, fs, [path, ...options]),
    lstatSync: (path: string, ...options: unknown[]) => virtualDirectories.has(path) ? directoryStat : Reflect.apply(fs.lstatSync, fs, [path, ...options]),
    existsSync: (path: string) => virtualDirectories.has(path) || fs.existsSync(path),
  };
});

const roots: string[] = [];
afterEach(() => {
  virtualDirectories.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-b-")));
  roots.push(root);
  const data = join(root, "coordinator");
  mkdirSync(data);
  const makeWorker = (name: string) => {
    const directories = ["home", "temp", "work"].map((kind) => join(root, name, kind));
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    return { instanceId: name, image: "boundary-fixture", command: ["fixture-engine"],
      home: directories[0]!, temp: directories[1]!, workspaces: [directories[2]!], network: "none", user: "1000:1000" };
  };
  const workers = { alice: makeWorker("alice"), bob: makeWorker("bob") };
  const path = join(data, "container-workers.json");
  const save = () => writeFileSync(path, JSON.stringify({ workers }));
  const sentinel = join(data, "private-config.json");
  writeFileSync(sentinel, "synthetic-control-plane-secret");
  save();
  const refused = () => {
    save();
    const before = readFileSync(path, "utf8");
    expect(() => readWorkerPolicy(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(sentinel, "utf8")).toBe("synthetic-control-plane-secret");
  };
  return { root, data, workers, path, save, refused };
}

describe("independent container mount and authority boundaries", () => {
  it("accepts disjoint bot directories outside coordinator data, with separate dedicated networks", () => {
    const f = fixture();
    f.workers.alice.network = "fixture-alice";
    f.workers.bob.network = "fixture-bob";
    f.save();
    expect(readWorkerPolicy(f.path).workers.alice?.home).toBe(f.workers.alice.home);
  });

  it.each(["home", "temp", "workspace"])("refuses a regular file as %s mount root", (kind) => {
    const f = fixture();
    const file = join(f.root, "not-a-directory");
    writeFileSync(file, "synthetic-file");
    if (kind === "workspace") f.workers.alice.workspaces = [file];
    else f.workers.alice[kind as "home" | "temp"] = file;
    f.refused();
    expect(readFileSync(file, "utf8")).toBe("synthetic-file");
  });

  it.skipIf(process.platform === "win32")("refuses a Unix socket as a mount root", async () => {
    const f = fixture();
    const socket = join(f.root, "socket");
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
    try {
      f.workers.alice.workspaces = [socket];
      f.refused();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });


  it.skipIf(process.platform === "win32" || !existsSync("/var/run"))("refuses canonical aliases of administrative socket directories", () => {
    const f = fixture();
    f.workers.alice.workspaces = [realpathSync("/var/run")];
    f.refused();
  });

  it.each(["same", "ancestor", "descendant", "own-home"])("refuses %s overlap between writable mounts", (kind) => {
    const f = fixture();
    if (kind === "same") f.workers.alice.workspaces = [f.workers.bob.workspaces[0]!];
    if (kind === "ancestor") f.workers.alice.workspaces = [join(f.root, "bob")];
    if (kind === "descendant") {
      const nested = join(f.workers.bob.workspaces[0]!, "nested");
      mkdirSync(nested);
      f.workers.alice.workspaces = [nested];
    }
    if (kind === "own-home") f.workers.alice.workspaces = [f.workers.alice.home];
    f.refused();
  });

  it.each(["home", "temp", "workspace"])("refuses symlink %s roots", (kind) => {
    const f = fixture();
    const link = join(f.root, "symlink");
    symlinkSync(f.workers.alice.workspaces[0]!, link, process.platform === "win32" ? "junction" : "dir");
    if (kind === "workspace") f.workers.alice.workspaces = [link];
    else f.workers.alice[kind as "home" | "temp"] = link;
    f.refused();
  });

  it.each(["directory", "ancestor", "private-child"])("refuses mounting the coordinator %s", (kind) => {
    const f = fixture();
    let mount = kind === "ancestor" ? f.root : f.data;
    if (kind === "private-child") {
      mount = join(f.data, "sessions");
      mkdirSync(mount);
    }
    f.workers.alice.workspaces = [mount];
    f.refused();
  });

  it.skipIf(process.platform === "win32").each(["/", "/home/agent", "/home/agent/nested", "/opt/omb", "/opt/omb/nested", "/proc", "/sys", "/dev", "/tmp"])(
    "refuses the reserved workspace destination %s", (destination) => {
      const f = fixture();
      virtualDirectories.add(destination);
      f.workers.alice.workspaces = [destination];
      f.refused();
    },
  );

  it.each(["0:1000", "000:1000", "1000:0", "1000:000", "-1:1000", "1000:-1", "root:root", "4294967295:1000"])(
    "refuses unsafe user identity %s", (identity) => {
      const f = fixture();
      f.workers.alice.user = identity;
      f.refused();
    },
  );

  it.each(["host", "bridge", "container", "container:other", "none\n--privileged"])("refuses unsafe network %s", (network) => {
    const f = fixture();
    f.workers.alice.network = network;
    f.refused();
  });

  it("refuses a shared named network", () => {
    const f = fixture();
    f.workers.alice.network = f.workers.bob.network = "shared-workers";
    f.refused();
  });

  it("refuses a provider instance assigned to two bots", () => {
    const f = fixture();
    f.workers.bob.instanceId = f.workers.alice.instanceId;
    f.refused();
  });
});
