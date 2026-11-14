import { format } from "node:util";
import { runProviderWorker } from "./container-workers/provider-worker.ts";

// Driver diagnostics must never share the provider protocol's stdout.
for (const method of ["log", "info", "debug"] as const) console[method] = (...values: unknown[]) => { process.stderr.write(`${format(...values)}\n`); };
runProviderWorker();
