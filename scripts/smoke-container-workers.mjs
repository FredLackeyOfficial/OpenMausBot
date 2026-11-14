import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const image = "omb-container-runtime:ci";
const matrixImage = "omb-container-runtime:matrix-ci";
const dockerCommand = process.env.OMB_DOCKER ?? "docker";
// The coordinator fixture deliberately narrows PATH to Node only. Pin the host
// executable before passing it to a worker policy so CI does not depend on PATH there.
const candidates = dockerCommand.includes("/") ? [resolve(dockerCommand)]
  : (process.env.PATH ?? "").split(delimiter).map(directory => resolve(directory, dockerCommand));
const docker = candidates.find(candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!docker) throw new Error(`Docker executable not found: ${dockerCommand}`);
const dockerArgs = process.env.OMB_DOCKER_CONFIG ? ["--config", process.env.OMB_DOCKER_CONFIG] : [];
const evidence = join(cwd, ".omb-scratch", "verify-evidence", "container-workers");
mkdirSync(evidence, { recursive: true });

async function run(command, args, environment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...environment } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

await run(docker, [...dockerArgs, "build", "-f", "server/container-workers/Dockerfile", "-t", image, "."]);
await run("pnpm", ["exec", "vitest", "run", "server/container-workers/docker.test.ts", "server/container-workers/http.e2e.test.ts",
  "--reporter=default", "--reporter=json", `--outputFile=${join(evidence, "docker-smoke-vitest.json")}`], {
  OMB_DOCKER_TEST: "1", OMB_DOCKER: docker, OMB_WORKER_IMAGE: image,
});
await run(docker, [...dockerArgs, "build", "--build-arg", `BASE_IMAGE=${image}`, "-f", "server/container-workers/testing/Dockerfile.matrix", "-t", matrixImage, "."]);
await run("pnpm", ["exec", "vitest", "run", "server/container-workers/provider-matrix.test.ts",
  "--reporter=default", "--reporter=json", `--outputFile=${join(evidence, "docker-matrix-vitest.json")}`], {
  OMB_DOCKER: docker, OMB_DOCKER_MATRIX_IMAGE: matrixImage,
});
