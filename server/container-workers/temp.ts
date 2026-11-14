import { chownSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "./policy.ts";

/** Only the newly created generation directory may have its ownership changed. */
export function createWorkerTemp(worker: Pick<Worker, "temp" | "user">, platform = process.platform): string {
  const directory = mkdtempSync(join(worker.temp, "omb-run-"));
  if (platform !== "linux") return directory;
  const [uid, gid] = worker.user.split(":").map(Number);
  try {
    const owner = statSync(directory);
    if (owner.uid !== uid && process.getuid?.() !== 0) throw new Error("The coordinator must run as the worker UID or root");
    if (owner.uid !== uid || owner.gid !== gid) chownSync(directory, uid, gid);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Cannot assign private worker temp directory to ${worker.user}; run the coordinator as that UID with its configured group, or root`, { cause: error });
  }
}
