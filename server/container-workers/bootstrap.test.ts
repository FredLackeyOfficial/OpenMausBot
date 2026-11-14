import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerWorkers } from "./policy.ts";
import { containerWorkerAccess } from "./bootstrap.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("leaves ordinary Windows startup available when no container policy exists", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-worker-bootstrap-")); roots.push(root);
  vi.stubGlobal("process", { ...process, platform: "win32" });
  expect(ContainerWorkers.open(join(root, "container-workers.json"))).toBeUndefined();
  const result = containerWorkerAccess(root, { desktopManaged: false, hostedWorkspace: false, env: { OMB_LOOPBACK_TRUST: "owner" } });
  expect(result.containerWorkers).toBeUndefined();
  expect(result.LOOPBACK.trust).toBe("owner");
});

it("refuses a configured container worker on Windows before parsing or launching it", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-worker-bootstrap-")); roots.push(root);
  const policy = join(root, "container-workers.json");
  writeFileSync(policy, "not parsed on an unsupported coordinator");
  vi.stubGlobal("process", { ...process, platform: "win32" });
  expect(() => ContainerWorkers.open(policy)).toThrow("Linux or macOS coordinator");
  expect(() => containerWorkerAccess(root, { desktopManaged: false, hostedWorkspace: false })).toThrow("Linux or macOS coordinator");
});
