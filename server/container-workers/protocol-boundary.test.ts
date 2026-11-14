import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InstanceRouteDeps } from "../routes/instances.ts";
import { createInstanceRoutes } from "../routes/instances.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { engineCommandCpuMs, engineProcessGone } from "../turn-watchdog.ts";
import { createContainerProvider } from "./provider.ts";
import { FRAME_BYTES, frameSchema, MAX_PENDING, WorkerChannel, type WorkerFrame } from "./protocol.ts";

const hostActions = vi.hoisted(() => ({
  probe: vi.fn(async () => ({})), candidates: vi.fn(() => []), update: vi.fn(async () => ({ version: "fixture" })),
  discover: vi.fn(async () => {}), remove: vi.fn(async () => {}),
}));
vi.mock("../drivers/ollama.ts", async (original) => ({ ...await original<typeof import("../drivers/ollama.ts")>(), findOllama: hostActions.probe, probeOllama: hostActions.probe }));
vi.mock("../env-path.ts", async (original) => ({ ...await original<typeof import("../env-path.ts")>(), findCliCandidates: hostActions.candidates }));
vi.mock("../claude-update.ts", async (original) => ({ ...await original<typeof import("../claude-update.ts")>(), updateClaudeCli: hostActions.update }));
vi.mock("../agent-endpoint-models.ts", async (original) => ({ ...await original<typeof import("../agent-endpoint-models.ts")>(), discoverAgentEndpointModels: hostActions.discover }));
vi.mock("../drivers/antigravity-acp.ts", async (original) => ({ ...await original<typeof import("../drivers/antigravity-acp.ts")>(), removeAntigravityProfile: hostActions.remove }));

type RequestFrame = Extract<WorkerFrame, { kind: "request" }>;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(environment: Record<string, string> = {}) {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: vi.fn(() => { setImmediate(() => { child.emit("exit", 143, null); child.emit("close", 143, null); }); return true; }), pid: 34567 }) as unknown as ChildProcessWithoutNullStreams;
  cleanup.push(() => { stdout.end(); child.stdin.destroy(); child.stderr.destroy(); });
  const outgoing: WorkerFrame[] = [];
  const events: RuntimeEvent[] = [];
  let buffer = "", held: RequestFrame | undefined;
  let hold: string | undefined;
  let capabilities: Record<string, unknown> = { sessionModelSwitch: "unsupported", agentsMcp: true };
  const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  const respond = (request: RequestFrame, value: unknown = null) => write({ kind: "response", version: 1,
    generation: request.generation, id: request.id, value: { value, state: { models: { default: "fixture", options: [] }, capabilities } } });
  child.stdin.on("data", (data: Buffer) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)) as WorkerFrame;
      buffer = buffer.slice(newline + 1);
      outgoing.push(frame);
      if (frame.kind !== "request") continue;
      if (frame.operation === hold) { held = frame; continue; }
      respond(frame, frame.operation === "sendTurn" ? { turnId: "turn-a" } : frame.operation === "snapshot" ? { state: "available" } : null);
    }
  });
  const instance = await createContainerProvider({ botId: "alice", driverKind: "fixture", input: {
    instanceId: "alice-engine", displayName: "Fixture", enabled: true, config: {}, environment,
  }, spawn: () => child });
  instance.adapter.onEvent((event) => events.push(event));
  const start = async (extra: Partial<SendTurnInput> = {}) => {
    await instance.adapter.sendTurn({ botId: "alice", threadId: "thread-a", text: "fixture", ...extra });
    return outgoing.findLast((frame): frame is RequestFrame => frame.kind === "request" && frame.operation === "sendTurn")!;
  };
  const event = (request: RequestFrame, overrides: Record<string, unknown> = {}, scope?: string) => write({
    kind: "event", version: 1, generation: request.generation, scope: scope ?? (request.payload as { scope: string }).scope,
    event: { eventId: "event-a", provider: "fixture", providerInstanceId: "alice-engine", threadId: "thread-a", turnId: "turn-a",
      createdAt: new Date().toISOString(), type: "content.delta", streamKind: "assistant_text", delta: "hello", ...overrides },
  });
  const callback = (request: RequestFrame, name: string, payload: unknown, id = "callback-a", scope?: string) => write({
    kind: "callback", version: 1, generation: request.generation, id,
    scope: scope ?? (request.payload as { scope: string }).scope, callback: name, payload,
  });
  return { child, instance, outgoing, events, write, respond, start, event, callback,
    hold: (operation: string) => { hold = operation; }, held: () => held,
    capabilities: (value: Record<string, unknown>) => { capabilities = value; } };
}

describe("independent worker framing boundary", () => {
  it.each(["__proto__", "constructor", "spawn", "readFile", "docker", "fetch"])("refuses arbitrary operation %s", (operation) => {
    expect(frameSchema.safeParse({ kind: "request", version: 1, generation: "generation", id: "id", operation, payload: {} }).success).toBe(false);
  });

  it.each(["malformed", "unknown", "oversized", "unterminated"])("fails closed on %s input without delivering it", (kind) => {
    const input = new PassThrough(), output = new PassThrough();
    const receive = vi.fn(), failed = vi.fn();
    const channel = new WorkerChannel(input, output, receive, failed);
    cleanup.push(() => channel.close());
    if (kind === "malformed") input.write("{invalid\n");
    if (kind === "unknown") input.write('{"kind":"spawn"}\n');
    if (kind === "oversized") input.write(`${"x".repeat(FRAME_BYTES + 1)}\n`);
    if (kind === "unterminated") { input.write("x".repeat(FRAME_BYTES)); input.write("x"); }
    expect(receive).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    input.write("malformed again\n");
    expect(failed).toHaveBeenCalledTimes(1);
  });


  it.each(["depth", "nodes"])("rejects excessive JSON %s before recursive sanitizing", (kind) => {
    const input = new PassThrough(), output = new PassThrough();
    const receive = vi.fn(), failed = vi.fn();
    const channel = new WorkerChannel(input, output, receive, failed);
    cleanup.push(() => channel.close());
    let payload: unknown = "leaf";
    if (kind === "depth") for (let index = 0; index < 50; index++) payload = { nested: payload };
    else payload = Array.from({ length: 100_001 }, () => null);
    input.write(`${JSON.stringify({ kind: "request", version: 1, generation: "generation", id: "id", operation: "snapshot", payload })}\n`);
    expect(receive).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("bounds output when the peer stops reading", () => {
    const input = new PassThrough();
    const output = new Writable({ write() {} });
    const failed = vi.fn();
    const channel = new WorkerChannel(input, output, vi.fn(), failed);
    cleanup.push(() => { channel.close(); output.destroy(); });
    const frame = { kind: "request", version: 1, generation: "generation", id: "id", operation: "snapshot", payload: "x".repeat(FRAME_BYTES / 2) } as const;
    expect(() => { for (let index = 0; index < 5; index++) channel.send(frame); }).toThrow(/limit/);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe("independent hostile provider boundary", () => {
  it.each([
    { threadId: "thread-b" }, { provider: "other-driver" }, { providerInstanceId: "bob-engine" }, { turnId: "turn-b" },
    { type: "host.spawn", pid: 1 }, { type: "cap.exhausted", handoffPath: "/synthetic-host-secret", reason: "cap" },
  ])("refuses event identity or authority injection %j", async (attack) => {
    const f = await fixture();
    const request = await f.start();
    f.event(request, attack);
    expect(f.events.some((event) => event.eventId === "event-a")).toBe(false);
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(f.instance.snapshot()).rejects.toThrow(/unavailable/);
  });

  it("refuses a fabricated scope", async () => {
    const f = await fixture();
    f.event(await f.start(), {}, "sibling-scope");
    expect(f.events.some((event) => event.eventId === "event-a")).toBe(false);
    expect(f.child.kill).toHaveBeenCalled();
  });

  it.each([
    { type: "request.opened", requestId: "request-a", requestType: "permission", summary: {}, tool: "shell" },
    { type: "content.delta", delta: { command: "host-command" } },
    { type: "turn.completed", ok: "true" },
  ])("rejects malformed subtype payload %j before host delivery", async (attack) => {
    const f = await fixture();
    f.event(await f.start(), attack);
    expect(f.events.some((event) => event.eventId === "event-a")).toBe(false);
    expect(f.child.kill).toHaveBeenCalled();
  });

  it("never turns worker-reported PIDs into coordinator process authority", async () => {
    const f = await fixture();
    const request = await f.start();
    f.event(request, { type: "session.started", sessionId: "session-a", pid: 1, enginePid: 1 });
    expect(f.instance.adapter.enginePid).toBeUndefined();
    const alive = vi.fn(), sample = vi.fn();
    expect(engineProcessGone(f.instance.adapter, "thread-a", alive)).toBe(false);
    expect(await engineCommandCpuMs(f.instance.adapter, "thread-a", 0, sample)).toBeNull();
    expect(alive).not.toHaveBeenCalled();
    expect(sample).not.toHaveBeenCalled();
    const admission = vi.fn(async () => {});
    await f.instance.adapter.interruptTurn("thread-a");
    const fresh = await fixture();
    const next = await fresh.start({ engineAdmission: admission });
    fresh.callback(next, "admission", { start: "session", joining: 1 });
    await tick();
    expect(admission).not.toHaveBeenCalled();
    expect(fresh.outgoing.at(-1)).toMatchObject({ kind: "callbackResult", error: expect.any(Object) });
  });

  it("rejects a generation replay and settles pending requests", async () => {
    const f = await fixture();
    f.hold("snapshot");
    const pending = f.instance.snapshot();
    const rejected = expect(pending).rejects.toThrow();
    await tick();
    const request = f.held()!;
    f.write({ kind: "response", version: 1, generation: "previous-generation", id: request.id, value: null });
    await rejected;
    expect(f.child.kill).toHaveBeenCalled();
  });

  it("rejects duplicate reply IDs without resolving another request", async () => {
    const f = await fixture();
    f.hold("snapshot");
    const rejected = expect(f.instance.snapshot()).rejects.toThrow();
    const init = f.outgoing[0] as RequestFrame;
    f.respond(init);
    await rejected;
    expect(f.child.kill).toHaveBeenCalled();
  });

  it("rejects pending operations when the worker transport ends", async () => {
    const f = await fixture();
    f.hold("snapshot");
    const rejected = expect(f.instance.snapshot()).rejects.toThrow(/closed/);
    await tick();
    f.child.stdout.emit("end");
    await rejected;
    expect(f.child.kill).toHaveBeenCalled();
  });

  it("bounds in-flight calls", async () => {
    const f = await fixture();
    f.hold("snapshot");
    const requests = Array.from({ length: MAX_PENDING }, () => f.instance.snapshot().catch(() => null));
    await expect(f.instance.snapshot()).rejects.toThrow(/limit/);
    f.child.stdout.emit("end");
    await Promise.all(requests);
  });

  it("keeps host integration credentials out of the worker wire", async () => {
    const f = await fixture({ PROVIDER_KEY: "synthetic-provider-credential" });
    await f.start({ integrations: { agents: { command: "host-only-command", args: ["host-only-argument"], env: {
      OMB_COMMS_TOKEN: "synthetic-coordinator-token", OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "alice", OMB_THREAD_ID: "thread-a",
    } }, hooks: { url: "http://127.0.0.1:1", token: "synthetic-hook-token" } }, approvalModeNow: () => "ask" });
    const wire = JSON.stringify(f.outgoing);
    expect(wire).not.toMatch(/synthetic-coordinator-token|synthetic-hook-token|host-only-command|host-only-argument|OMB_HARNESS_URL/);
    expect(wire).toContain("synthetic-provider-credential");
  });

  it("redacts configured credentials in worker error replies", async () => {
    const f = await fixture({ PROVIDER_KEY: "independent-secret-value" });
    f.hold("snapshot");
    const rejected = expect(f.instance.snapshot()).rejects.toThrow(/\[redacted\]/);
    await tick();
    const request = f.held()!;
    f.write({ kind: "response", version: 1, generation: request.generation, id: request.id,
      error: { name: "Error", message: "failed with independent-secret-value" } });
    await rejected;
  });

  it("refuses approval callbacks for retired turns and withholds late grants", async () => {
    const f = await fixture();
    let finish!: (value: "full") => void;
    const approval = vi.fn(() => new Promise<"full">((resolve) => { finish = resolve; }));
    const request = await f.start({ approvalModeNow: approval });
    f.callback(request, "approval", null);
    await tick();
    expect(approval).toHaveBeenCalledTimes(1);
    await f.instance.adapter.interruptTurn("thread-a");
    finish("full");
    await tick();
    expect(f.outgoing.find((frame) => frame.kind === "callbackResult" && frame.id === "callback-a")).toBeUndefined();
    f.callback(request, "approval", null, "callback-b");
    await tick();
    expect(approval).toHaveBeenCalledTimes(1);
    expect(f.outgoing.find((frame) => frame.kind === "callbackResult" && frame.id === "callback-b")).toBeUndefined();
  });

  it("does not accept permission responses for another thread or a completed turn", async () => {
    const f = await fixture();
    const request = await f.start();
    f.event(request, { type: "request.opened", requestId: "request-a", requestType: "permission", tool: "shell", summary: "synthetic command" });
    expect(await f.instance.adapter.respondToRequest("thread-b", "request-a", { behavior: "allow" })).toBe("unavailable");
    f.event(request, { type: "turn.completed", ok: true });
    expect(await f.instance.adapter.respondToRequest("thread-a", "request-a", { behavior: "allow" })).toBe("unavailable");
    expect(f.outgoing.some((frame) => frame.kind === "request" && frame.operation === "respondToRequest")).toBe(false);
  });


  it.each(["use_tool", "read_file", "run_command", "list_bots"])("refuses ungranted coordination tool %s", async (name) => {
    const f = await fixture();
    const request = await f.start({ integrations: { agents: { command: "host-only", args: [], env: {
      OMB_COMMS_TOKEN: "synthetic-coordinator-token", OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "alice", OMB_THREAD_ID: "thread-a",
    } } } });
    f.callback(request, "coordination", { jsonrpc: "2.0", id: "mcp-a", method: "tools/call", params: { name, arguments: {} } });
    await tick();
    expect(f.outgoing.at(-1)).toMatchObject({ kind: "callbackResult", error: { message: expect.stringMatching(/refused/) } });
  });

  it("rejects duplicate callback IDs before repeating host work", async () => {
    const f = await fixture();
    const admission = vi.fn(async () => {});
    const request = await f.start({ engineAdmission: admission });
    f.callback(request, "admission", "process");
    await tick();
    expect(admission).toHaveBeenCalledTimes(1);
    f.callback(request, "admission", "process");
    await tick();
    expect(admission).toHaveBeenCalledTimes(1);
    expect(f.child.kill).toHaveBeenCalled();
  });

  it("does not expose native raw event payloads", async () => {
    const f = await fixture();
    f.event(await f.start(), { raw: { token: "synthetic-native-secret" } });
    const event = f.events.find((item) => item.eventId === "event-a");
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty("raw");
    expect(JSON.stringify(event)).not.toContain("synthetic-native-secret");
  });


  it("strips worker fields that could trigger coordinator MCP subprocess probes", async () => {
    const f = await fixture();
    f.event(await f.start(), { type: "session.started", sessionId: "session-a", mcpFailed: ["configured-host-server"] });
    const event = f.events.find((item) => item.eventId === "event-a");
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty("mcpFailed");
  });

  it("cannot advertise host tools or gain host helpers through capabilities", async () => {
    const f = await fixture();
    f.capabilities({ sessionModelSwitch: "in-session", browserMcp: true, computerMcp: true, customMcp: true, hooks: true, enginePid: 1, generateText: true });
    await f.instance.refreshModels?.();
    expect(f.instance.adapter.capabilities).toMatchObject({ browserMcp: false, computerMcp: false, customMcp: false, hooks: false });
    for (const name of ["generateText", "generateMemoryText", "reviewPermission", "startAuthentication", "installRuntime"] as const) expect(f.instance[name]).toBeUndefined();
    expect(f.instance.adapter.cacheKeepWarm).toBeUndefined();
  });
});


describe("independent container control-route execution boundary", () => {

  it("refreshes only the worker catalog without host endpoint discovery", async () => {
    hostActions.discover.mockClear();
    const refreshModels = vi.fn(async () => true);
    const persist = vi.fn(async () => {});
    const route = createInstanceRoutes({
      isolateWorkers: true, hostedModels: false,
      cfg: { instances: { alice: { driver: "claudeAgent", config: { endpointModels: [] }, environment: { ANTHROPIC_BASE_URL: "https://fixture.invalid" } } } },
      store: { bots: [], tasks: () => [] }, registry: { onWrongCli: vi.fn(), refreshModels },
      describeInstances: async () => [], persistProviderInstance: persist,
      providerConfigBusy: { get: () => false, set: vi.fn() },
    } as unknown as InstanceRouteDeps);
    const json = vi.fn();
    const url = new URL("http://fixture.invalid/api/instances/alice/refresh-models");
    await route({ req: { headers: { "content-type": "application/json" } } as IncomingMessage,
      res: { setHeader: vi.fn() } as unknown as ServerResponse, url, path: url.pathname, method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody: vi.fn(async () => ({})) });
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, expect.anything());
    expect(refreshModels).toHaveBeenCalledWith("alice");
    expect(hostActions.discover).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", "/api/cli-test"], ["GET", "/api/cli-candidates?name=fixture"], ["GET", "/api/instances/ollama"],
    ["POST", "/api/instances/alice/claude-update"], ["POST", "/api/instances/alice/install"], ["POST", "/api/instances/alice/check"],
    ["POST", "/api/instances/alice/auth/start"], ["POST", "/api/instances/alice/auth/complete"], ["POST", "/api/instances/alice/auth/cancel"],
    ["POST", "/api/instances/alice/auth/sign-out"], ["GET", "/api/instances/alice/auth/status"],
    ["POST", "/api/instances/claude-accounts"], ["POST", "/api/instances/chatgpt-accounts"], ["POST", "/api/instances/openai-compat"],
    ["POST", "/api/instances/claude-endpoint"], ["POST", "/api/instances/codex-endpoint"], ["POST", "/api/instances/claude-bedrock"],
    ["PATCH", "/api/instances/alice"], ["PATCH", "/api/instances/alice/claude-bedrock"], ["PATCH", "/api/instances/alice/icon"],
    ["DELETE", "/api/instances/antigravity-alice"],
  ])("refuses %s %s before any host operation", async (method, path) => {
    for (const action of Object.values(hostActions)) action.mockClear();
    const forbidden = vi.fn(() => { throw new Error("Unexpected host operation"); });
    const deps = {
      isolateWorkers: true, hostedModels: false, store: { bots: [], tasks: () => [] }, cfg: { instances: {} },
      registry: { onWrongCli: vi.fn(), get: forbidden, refreshModels: forbidden, installRuntime: forbidden, cliTarget: forbidden, forgetSnapshots: forbidden },
      providerAuthSessions: { start: forbidden, status: forbidden, signOut: forbidden, complete: forbidden, cancel: forbidden },
      testCliBinary: forbidden, cliProbeEnvironment: forbidden, persistProviderInstance: forbidden,
      providerConfigBusy: { get: () => false, set: forbidden }, providerInstancesChanging: new Set(),
      describeInstances: forbidden, configStatus: forbidden, broadcast: forbidden, threadBusy: () => false,
      botForThread: () => null, activeGroupTurnForBot: () => null,
    } as unknown as InstanceRouteDeps;
    const route = createInstanceRoutes(deps);
    const json = vi.fn();
    const readBody = vi.fn(async () => { throw new Error("Request body must remain unread"); });
    const url = new URL(path!, "http://fixture.invalid");
    await route({ req: { headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      res: { setHeader: vi.fn() } as unknown as ServerResponse, url, path: url.pathname, method: method!,
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    expect(json).toHaveBeenCalledWith(expect.anything(), 409, expect.objectContaining({ error: expect.any(String) }));
    expect(forbidden).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    for (const action of Object.values(hostActions)) expect(action).not.toHaveBeenCalled();
  });
});
