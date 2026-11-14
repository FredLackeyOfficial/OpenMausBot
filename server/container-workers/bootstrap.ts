import { join } from "node:path";
import { ContainerWorkers } from "./policy.ts";
import { resolveLoopbackTrust } from "../request-auth.ts";

export function containerWorkerAccess(dataDir: string, input: Parameters<typeof resolveLoopbackTrust>[0]) {
  const containerWorkers = ContainerWorkers.open(join(dataDir, "container-workers.json"));
  if (containerWorkers && input.desktopManaged) throw new Error("Container workers require the standalone server with authenticated clients");
  const LOOPBACK = resolveLoopbackTrust({ ...input, ...(containerWorkers ? {
    env: { ...process.env, OMB_LOOPBACK_TRUST: "service", OMB_DEV_TRUST_LOCAL_BROWSER: "0" },
  } : {}) });
  return { containerWorkers, LOOPBACK };
}
