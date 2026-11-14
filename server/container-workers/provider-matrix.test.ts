import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chownSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createContainerProvider } from "./provider.ts";
import { spawnContainerWorker } from "./transport.ts";
import { buildSync } from "esbuild";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { SendTurnInput } from "../contracts.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cleanup: Array<() => Promise<void>> = [];
const dockerImage = process.env.OMB_DOCKER_MATRIX_IMAGE;
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const API = {
  grok: "FIXTURE_API_KEY", "openai-compat": "FIXTURE_API_KEY", minimax: "MINIMAX_API_KEY", mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY", groq: "GROQ_API_KEY", greenference: "GREENFERENCE_API_KEY", modelgo: "MODELGO_API_KEY", meta: "META_API_KEY",
} as const;

interface CliCase { kind: string; file?: string; env?: Record<string, string>; model?: string }
const CLI: CliCase[] = [
  { kind: "claudeAgent", file: "fake-claude-cli.ts", env: { FAKE_CLAUDE_MODE: "happy" } },
  { kind: "codex", file: "fake-codex-app-server.ts" },
  { kind: "piAgent", file: "fake-pi-cli.ts" },
  { kind: "museCode", file: "../container-workers/testing/fake-muse.mjs", env: { META_API_KEY: "synthetic-muse-key" } },
  { kind: "grokAgent" }, { kind: "geminiAgent", env: { GEMINI_API_KEY: "synthetic-gemini-key" } },
  { kind: "kimiAgent" }, { kind: "droidAgent", env: { FACTORY_API_KEY: "synthetic-factory-key", FAKE_ACP_MODES: "default,auto-high" } },
  { kind: "cursorAgent", env: { CURSOR_API_KEY: "synthetic-cursor-key", FAKE_ACP_VERSION: "2026.10.22" } },
  { kind: "opencodeGo", env: { OPENCODE_API_KEY: "synthetic-opencode-key", FAKE_ACP_MODELS: "openai/fixture" }, model: "openai/fixture" },
  { kind: "qwenAgent", env: { FAKE_ACP_MODELS: "fixture(openai)" }, model: "fixture(openai)" },
  { kind: "hermesAgent" }, { kind: "clineAgent", env: { CLINE_API_KEY: "synthetic-cline-key" }, model: "cline-default" },
  { kind: "copilotAgent", env: { GH_TOKEN: "synthetic-github-key", FAKE_ACP_MODELS: "auto" }, model: "auto" },
  { kind: "commandCodeAgent", env: { COMMAND_CODE_API_KEY: "synthetic-command-key" } },
  { kind: "kiroAgent", env: { KIRO_API_KEY: "synthetic-kiro-key", FAKE_ACP_AUTOPILOT: "1" } },
  { kind: "ompAgent", env: { FAKE_ACP_VERSION: "omp/14.5.0", FAKE_ACP_MODELS: "openai/fixture" }, model: "openai/fixture" },
  { kind: "deepseekAgent", env: { DEEPSEEK_API_KEY: "synthetic-deepseek-key", FAKE_ACP_MODELS: "deepseek-v4-flash" }, model: "deepseek-v4-flash" },
  { kind: "antigravityAgent", env: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODES: "default,auto_edit,yolo", FAKE_ACP_MODELS: "gemini-3.8-flash" }, model: "gemini-3.8-flash" },
  { kind: "customAcp" },
];

async function worker(kind: string, configure: (paths: { directory: string; home: string; workspace: string; data: string; instanceId: string }) => { config: unknown; environment: Record<string, string> }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-worker-matrix-")));
  const home = join(directory, "home"), temp = join(directory, "tmp"), workspace = join(directory, "workspace"), data = join(home, ".openmausbot");
  for (const path of [home, temp, workspace, data]) mkdirSync(path, { recursive: true });
  cleanup.push(() => removeTempDir(directory));
  const instanceId = `fixture-${kind}`;
  const { config, environment } = configure({ directory, home, workspace, data, instanceId });
  const policy = join(directory, "coordinator/policy.json");
  if (dockerImage) {
    if (process.platform === "linux" && process.getuid?.() === 0) {
      const own = (path: string) => {
        chownSync(path, 1000, 1000);
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) own(child); else chownSync(child, 1000, 1000);
        }
      };
      for (const path of [home, temp, workspace]) own(path);
    }
    mkdirSync(dirname(policy));
    writeFileSync(policy, JSON.stringify({ docker: process.env.OMB_DOCKER ?? "/usr/bin/docker", dockerConfig: process.env.OMB_DOCKER_CONFIG, workers: {
      "fixture-bot": { instanceId, image: dockerImage, home, temp, workspaces: [workspace], network: "none", user: process.platform === "linux" && process.getuid?.() ? `${process.getuid()}:${process.getgid!()}` : "1000:1000" },
    } }));
  }
  const wire: string[] = [];
  let diagnostics = "";
  const provider = await createContainerProvider({ botId: "fixture-bot", driverKind: kind,
    input: { instanceId, displayName: kind, enabled: true, environment, config },
    spawn: () => {
      const child = dockerImage ? spawnContainerWorker(policy, "fixture-bot") : spawn(process.execPath, ["--import", join(root, "container-workers/testing/offline-fetch.mjs"), join(root, "container-worker.ts")], {
        cwd: workspace, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: temp, OMB_DATA_DIR: data, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache") },
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: Buffer | string, ...args: unknown[]) => { wire.push(chunk.toString()); return Reflect.apply(write, child.stdin, [chunk, ...args]); }) as typeof child.stdin.write;
      child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_000); });
      if (!dockerImage) {
        const kill = child.kill.bind(child);
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        child.kill = (signal) => {
          if (signal !== "SIGTERM") return kill(signal);
          child.stdin.end();
          stopTimer ??= setTimeout(() => kill("SIGKILL"), 5_000); stopTimer.unref();
          return true;
        };
        child.on("exit", () => {
          if (stopTimer) clearTimeout(stopTimer);
          if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
        });
      }
      return child;
    },
  });
  cleanup.push(async () => {
    try { await provider.dispose(); }
    catch (error) { throw new Error(`Worker fixture ${kind} cleanup failed: ${diagnostics}`, { cause: error }); }
  });
  const recorder = recordEvents(provider.adapter);
  cleanup.push(async () => { recorder.stop(); });
  return { provider, recorder, workspace, home, temp, wire, diagnostics: () => diagnostics };
}

async function endpoint() {
  const requests: Record<string, unknown>[] = [];
  let assignments = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/api/internal/")) {
      expect(request.headers.authorization).toBe("Bearer synthetic-coordinator-capability");
      if (request.url.startsWith("/api/internal/assignment-status")) assignments++;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ outstanding: [] })); return;
    }
    if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    let text = ""; for await (const chunk of request) text += String(chunk);
    expect(request.headers.authorization).toBe("Bearer synthetic-provider-key");
    const body = JSON.parse(text); requests.push(body);
    const listed = body.tools?.find((tool: { function?: { name?: string } }) => tool.function?.name?.endsWith("assignment_status"));
    const toolResult = body.messages.some((message: { role: string }) => message.role === "tool");
    stream(response, listed && !toolResult ? { tool_calls: [{ index: 0, id: "assignment-call", type: "function", function: { name: listed.function.name, arguments: "{}" } }] } : { content: "fixture response" }, listed && !toolResult ? "tool_calls" : "stop");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  return { url: `http://127.0.0.1:${address.port}`, requests, assignments: () => assignments };
}
function stream(response: ServerResponse, delta: unknown, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}

function bundledFixture(script: string, output: string): string {
  if (!dockerImage) return script;
  buildSync({ entryPoints: [script], outfile: output, bundle: true, platform: "node", format: "esm", target: "node24",
    banner: { js: 'import { createRequire as __fixtureRequire } from "node:module"; const require = __fixtureRequire(import.meta.url);' } });
  return output;
}
function command(path: string, script: string) {
  script = bundledFixture(script, `${path}.mjs`);
  const node = dockerImage ? "/usr/local/bin/node" : process.execPath;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`, { mode: 0o755 });
}

describe.skipIf(process.platform === "win32")(dockerImage ? "registered drivers in actual Docker (synthetic client/provider protocols)" : "registered drivers in isolated worker subprocesses (synthetic protocols, not Docker qualification)", () => {
  it("covers every registered driver exactly once", async () => {
    const { BUILT_IN_DRIVERS } = await import("../drivers/builtIn.ts");
    expect([...Object.keys(API), ...CLI.map((entry) => entry.kind)].sort()).toEqual(BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort());
  });
  it.each(Object.entries(API))("%s streams a complete API turn and invokes worker-local MCP coordination", async (kind, key) => {
    const api = await endpoint();
    const fixture = await worker(kind, () => ({ config: { url: `${dockerImage ? "http://127.0.0.1:18777" : api.url}/v1`, apiKeyEnv: key }, environment: { [key]: "synthetic-provider-key" } }));
    const threadId = randomUUID();
    const agents: NonNullable<SendTurnInput["integrations"]>["agents"] = { command: "must-not-execute-on-host", args: [], env: { OMB_BOT_ID: "fixture-bot", OMB_THREAD_ID: threadId, OMB_HARNESS_URL: api.url, OMB_COMMS_TOKEN: "synthetic-coordinator-capability" } };
    await fixture.provider.adapter.sendTurn({ botId: "fixture-bot", threadId, text: "Check assignments", model: "fixture-model", cwd: fixture.workspace, approvalMode: "ask", integrations: { agents } });
    const completed = await fixture.recorder.until((event) => event.type === "turn.completed", 20_000);
    expect(completed, JSON.stringify(fixture.recorder.events) + fixture.diagnostics()).toMatchObject({ ok: true });
    expect(api.assignments()).toBe(1);
    if (!dockerImage) expect(api.requests).toHaveLength(2);
    expect(fixture.wire.join("")).not.toContain("synthetic-coordinator-capability");
    expect(fixture.recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text" && event.text.includes("fixture response"))).toBe(true);
  }, dockerImage ? 90_000 : 30_000);

  it.each(CLI)("$kind completes its real driver protocol against a synthetic executable", async (entry) => {
    const fixture = await worker(entry.kind, ({ workspace, home, data, instanceId }) => {
      const cli = join(workspace, "fixture-cli");
      const script = join(root, "testing", entry.file ?? "fake-acp-cli.ts");
      command(cli, script);
      if (entry.kind === "qwenAgent") {
        mkdirSync(join(home, ".qwen"), { recursive: true });
        writeFileSync(join(home, ".qwen/settings.json"), JSON.stringify({ modelProviders: { openai: [{ id: "fixture" }] } }));
      }
      if (entry.kind === "antigravityAgent") {
        command(join(workspace, "localharness_external"), script);
        const profile = join(data, "providers/antigravity", createHash("sha256").update(instanceId).digest("hex"), "antigravity-acp");
        mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, "acp_token.json"), '{"fixture":true}');
      }
      return { config: { cli, fullAuto: false }, environment: { FAKE_ACP_TEXT_REPLY: "fixture response", FAKE_ACP_DUMP: join(workspace, "launch.json"), ...entry.env } };
    });
    try {
      await fixture.provider.adapter.sendTurn({ botId: "fixture-bot", threadId: randomUUID(), text: "Say hello", cwd: fixture.workspace, ...(entry.model ? { model: entry.model } : {}), approvalMode: "ask" });
    } catch (error) { throw new Error(`Worker fixture ${entry.kind} failed: ${fixture.diagnostics()}`, { cause: error }); }
    const completed = await fixture.recorder.until((event) => event.type === "turn.completed", 20_000);
    expect(completed, JSON.stringify(fixture.recorder.events) + fixture.diagnostics()).toMatchObject({ ok: true });
    expect(fixture.recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(true);
    if (entry.kind === "clineAgent") {
      const launch = JSON.parse(readFileSync(join(fixture.workspace, "launch.json"), "utf8"));
      const settings = launch.env.CLINE_MCP_SETTINGS_PATH;
      expect(settings.startsWith((dockerImage ? "/tmp" : fixture.temp) + "/")).toBe(true);
      const hostSettings = dockerImage ? join(fixture.temp, readdirSync(fixture.temp).find((name) => name.startsWith("omb-run-"))!, settings.slice(5)) : settings;
      expect(JSON.parse(readFileSync(hostSettings, "utf8"))).toEqual({ mcpServers: {} });
      expect(statSync(hostSettings).mode & 0o777).toBe(0o600);
    }
  }, dockerImage ? 90_000 : 30_000);
  it("executes Antigravity filesystem callbacks in the worker and refuses paths outside its session workspace", async () => {
    let receipt = "", outsideWrite = "", insideWrite = "";
    const fixture = await worker("antigravityAgent", ({ directory, workspace, data, instanceId }) => {
      const cli = join(workspace, "fixture-cli");
      const proxy = join(root, "container-workers/testing/acp-filesystem-proxy.mjs");
      command(cli, proxy); command(join(workspace, "localharness_external"), proxy);
      const profile = join(data, "providers/antigravity", createHash("sha256").update(instanceId).digest("hex"), "antigravity-acp");
      mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, "acp_token.json"), '{"fixture":true}');
      const insideRead = join(workspace, "inside.txt"), outsideRead = join(directory, "outside.txt");
      writeFileSync(insideRead, "allowed callback input"); writeFileSync(outsideRead, "forbidden callback input");
      receipt = join(workspace, "filesystem.json"); insideWrite = join(workspace, "written.txt"); outsideWrite = join(directory, "must-not-exist.txt");
      return { config: { cli }, environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODES: "default,auto_edit,yolo", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_TEXT_REPLY: "fixture response",
        FIXTURE_BASE_ACP: bundledFixture(join(root, "testing/fake-acp-cli.ts"), join(workspace, "base-acp.mjs")), FIXTURE_INSIDE_READ: insideRead, FIXTURE_OUTSIDE_READ: outsideRead,
        FIXTURE_INSIDE_WRITE: insideWrite, FIXTURE_OUTSIDE_WRITE: outsideWrite, FIXTURE_FS_RECEIPT: receipt,
      } };
    });
    await fixture.provider.adapter.sendTurn({ botId: "fixture-bot", threadId: randomUUID(), text: "Exercise callbacks", cwd: fixture.workspace, approvalMode: "ask" });
    expect(await fixture.recorder.until((event) => event.type === "turn.completed", 20_000), fixture.diagnostics()).toMatchObject({ ok: true });
    const results = JSON.parse(readFileSync(receipt, "utf8"));
    expect(results.insideRead.result.content).toBe("allowed callback input");
    expect(results.outsideRead.error.message).toContain("outside");
    expect(results.outsideWrite.error.message).toContain("outside");
    expect(readFileSync(insideWrite, "utf8")).toBe("worker callback wrote this");
    expect(existsSync(outsideWrite)).toBe(false);
  }, dockerImage ? 90_000 : 30_000);

});
