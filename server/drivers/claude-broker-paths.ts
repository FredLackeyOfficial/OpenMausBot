import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { workerIpcDirectory } from "../container-workers/ipc.ts";
import { brokerSocketPath } from "../procs.ts";

export function permissionSocketPath(threadId: string, botId?: string) {
  // Half the tag digests the full bot+thread key: Windows named pipes share one global namespace
  // and are never unlinked, and 8 chars keeps POSIX paths under the 104-byte sun_path limit.
  const key = botId ? `${botId}\0${threadId}` : threadId;
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 4);
  return brokerSocketPath(workerIpcDirectory() ?? DATA_DIR, `${prefix}${digest}`);
}

/** Broker bind paths, in order. Windows pipe names are never unlinkable (a hung child can hold one
 * for minutes), and macOS rejects socket paths past `sun_path`, hence the short temp fallback. */
export function brokerSocketCandidates(threadId: string, botId?: string): string[] {
  const base = permissionSocketPath(threadId, botId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${botId ?? ""}\0${threadId}`)
      .digest("hex")
      .slice(0, 16);
    return [base, join(workerIpcDirectory() ?? tmpdir(), `omb-perm-${scope}.sock`)];
  }
  return [
    base,
    `${base}-${randomBytes(3).toString("hex")}`,
    `${base}-${randomBytes(3).toString("hex")}`,
  ];
}
