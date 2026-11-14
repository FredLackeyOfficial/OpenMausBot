import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkerTemp } from "./temp.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), chownSync: vi.fn() }));
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "omb-temp-owner-")); roots.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); vi.mocked(chownSync).mockReset(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("assigns only the fresh Linux temp directory to the non-root worker and keeps it private", () => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  const parent = root();
  const directory = createWorkerTemp({ temp: parent, user: "12345:12345" }, "linux");
  expect(chownSync).toHaveBeenCalledExactlyOnceWith(directory, 12345, 12345);
  expect(directory.startsWith(`${parent}/omb-run-`)).toBe(true);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});

it("refuses mismatched Linux non-root ownership without widening permissions", () => {
  vi.spyOn(process, "getuid").mockReturnValue(54321);
  const parent = root();
  expect(() => createWorkerTemp({ temp: parent, user: "12345:12345" }, "linux")).toThrow(/Cannot assign private worker temp/);
  expect(chownSync).not.toHaveBeenCalled();
  expect(readdirSync(parent)).toEqual([]);
});

it("removes only the new directory if Linux ownership assignment fails", () => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.mocked(chownSync).mockImplementation(() => { throw new Error("EPERM"); });
  const parent = root();
  expect(() => createWorkerTemp({ temp: parent, user: "12345:12345" }, "linux")).toThrow(/configured group/);
  expect(existsSync(parent)).toBe(true);
  expect(readdirSync(parent)).toEqual([]);
});

it("leaves Docker Desktop filesystem ownership translation to its host", () => {
  const directory = createWorkerTemp({ temp: root(), user: "12345:12345" }, "darwin");
  expect(existsSync(directory)).toBe(true);
  expect(chownSync).not.toHaveBeenCalled();
});
