import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyProviderDriver, ProviderInstance, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "../contracts.ts";
import { createContainerProvider } from "./provider.ts";
import { runProviderWorker } from "./provider-worker.ts";

const instances: ProviderInstance[] = [];
const restoreEnvironment: Array<() => void> = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.dispose())); for (const restore of restoreEnvironment.splice(0)) restore(); });

async function fixture(driverKind = "fixture", environment: Record<string, string> = {}, config: unknown = { value: "kept" }) {
  for (const key of [...Object.keys(environment), ...(driverKind === "codex" ? ["CODEX_HOME"] : [])]) {
    const previous = process.env[key];
    restoreEnvironment.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const children: ChildProcessWithoutNullStreams[] = [];
  let closeCode = 0, deferClose = false;
  const delayedCloses: Array<() => void> = [];
  let eventListener: RuntimeEventListener | undefined, turn: SendTurnInput | undefined;
  let options = [{ id: "one", label: "One" }];
  const emit = (fields: Record<string, unknown>) => eventListener?.({ eventId: crypto.randomUUID(), provider: driverKind, threadId: "thread", turnId: "turn", createdAt: new Date().toISOString(), ...fields } as RuntimeEvent);
  const native: ProviderInstance = {
    instanceId: "engine", driverKind, displayName: "Fixture", enabled: true,
    get models() { return { default: "one", options }; },
    snapshot: async () => ({ state: "available", authenticated: true }),
    refreshModels: async () => { options = [...options, { id: "two", label: "Two" }]; },
    dispose: vi.fn(async () => {}),
    adapter: {
      provider: driverKind, capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true, engineAdmission: true },
      sendTurn: vi.fn(async (input) => { turn = input; await input.engineAdmission?.("process", 999999); emit({ type: "session.started", sessionId: "session" }); emit({ type: "turn.started" }); return { turnId: "turn" }; }),
      interruptTurn: vi.fn(async () => { emit({ type: "turn.completed", ok: false, stopReason: "interrupted" }); }),
      respondToRequest: vi.fn(async () => "allowed-once" as const), hasSession: () => Boolean(turn),
      stopAll: vi.fn(async () => { emit({ type: "turn.completed", ok: false }); }),
      onEvent(listener) { eventListener = listener; return () => { eventListener = undefined; }; },
      enginePid: () => 999999,
    },
  };
  const driver: AnyProviderDriver = { driverKind, metadata: { displayName: "Fixture" }, models: native.models, decodeConfig: vi.fn((value) => value), defaultConfig: () => ({}), create: vi.fn(async () => native) };
  const facade = await createContainerProvider({ botId: "bot", driverKind, input: { instanceId: "engine", displayName: "Fixture", environment, enabled: true, config }, spawn: () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn(() => { stdin.end(); return true; }) }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    runProviderWorker({ input: stdin, output: stdout, loadDrivers: async () => [driver], onClose: () => { const close = () => { child.emit("exit", closeCode); child.emit("close", closeCode, null); }; if (deferClose) delayedCloses.push(close); else close(); } });
    return child;
  } });
  instances.push(facade);
  return { facade, native, driver, emit, turn: () => turn!, children, cleanupCode: (value: number) => { closeCode = value; }, holdCleanup: () => { deferClose = true; }, finishCleanup: () => { deferClose = false; for (const close of delayedCloses.splice(0)) close(); } };
}

describe("provider worker lifecycle", () => {
  it.each(["OMB_OPENAI_API_KEY", "OMB_OPENROUTER_API_KEY", "OMB_ANTHROPIC_API_KEY"])("accepts the explicitly assigned provider credential %s", async (name) => {
    const { driver } = await fixture("fixture", { [name]: "synthetic-selected-key" });
    expect(driver.create).toHaveBeenCalledWith(expect.objectContaining({ environment: { [name]: "synthetic-selected-key" } }));
  });
  it("assigns Codex direct endpoints the worker home without accepting a coordinator path", async () => {
    const { driver } = await fixture("codex", { OPENMAUSBOT_CODEX_API_KEY: "synthetic-endpoint-key" });
    expect(driver.create).toHaveBeenCalledWith(expect.objectContaining({ environment: { OPENMAUSBOT_CODEX_API_KEY: "synthetic-endpoint-key", CODEX_HOME: join(process.env.HOME!, ".codex") } }));
  });
  it("holds new turns until supervisor cleanup is confirmed", async () => {
    const { facade, children, holdCleanup, finishCleanup } = await fixture();
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "First" });
    holdCleanup();
    const stopping = facade.adapter.interruptTurn("thread", "turn");
    const next = facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Second" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(1);
    finishCleanup();
    await stopping; await next;
    expect(children).toHaveLength(2);
  });

  it("blocks recreation when the supervisor cannot confirm namespace cleanup", async () => {
    const { facade, children, cleanupCode } = await fixture();
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "First" });
    cleanupCode(70);
    await expect(facade.adapter.stopAll()).rejects.toThrow("cleanup could not be confirmed");
    await expect(facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Must not run" })).rejects.toThrow("restart is blocked");
    expect(children).toHaveLength(1);
    instances.splice(instances.indexOf(facade), 1);
  });

  it("cancels a new generation while its driver is still initializing", async () => {
    const { facade, driver, native, children } = await fixture();
    await facade.adapter.stopAll();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    driver.create = async () => { await held; return native; };
    const pending = facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Never dispatch" });
    const rejected = expect(pending).rejects.toThrow(/stopped/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await facade.adapter.interruptTurn("thread");
    await rejected;
    expect(children).toHaveLength(2);
    expect(children[1]!.kill).toHaveBeenCalled();
    release();
    expect(native.adapter.sendTurn).not.toHaveBeenCalled();
  });

  it("starts a fresh generation after Stop while keeping listeners and model getters", async () => {
    const { facade, children, driver } = await fixture();
    const events: RuntimeEvent[] = [];
    facade.adapter.onEvent((event) => events.push(event));
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "First" });
    await facade.adapter.interruptTurn("thread", "turn");
    expect(children).toHaveLength(1);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(facade.adapter.hasSession("thread")).toBe(false);
    expect(facade.models.default).toBe("one");
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Second" });
    expect(children).toHaveLength(2);
    expect(driver.create).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2);
    expect(facade.adapter.hasSession("thread")).toBe(true);
  });

  it("does not let a stale turn's Stop terminate a newly started generation", async () => {
    const { facade, children, native } = await fixture();
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "First" });
    await facade.adapter.stopAll();
    native.adapter.sendTurn = async () => ({ turnId: "new-turn" });
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Second" });
    await facade.adapter.interruptTurn("thread", "turn");
    expect(children[1]!.kill).not.toHaveBeenCalled();
    await facade.adapter.interruptTurn("thread", "new-turn");
    expect(children[1]!.kill).toHaveBeenCalledOnce();
  });

  it("reports cancellation to every active thread of the stopped bot", async () => {
    const { facade, native, emit, children } = await fixture();
    native.adapter.sendTurn = async (input) => { emit({ type: "turn.started", threadId: input.threadId, turnId: input.threadId }); return { turnId: input.threadId }; };
    const events: RuntimeEvent[] = [];
    facade.adapter.onEvent((event) => events.push(event));
    await facade.adapter.sendTurn({ botId: "bot", threadId: "one", text: "First" });
    await facade.adapter.sendTurn({ botId: "bot", threadId: "two", text: "Second" });
    await facade.adapter.interruptTurn("one", "one");
    expect(events.filter((event) => event.type === "turn.completed" && !event.ok).map((event) => event.threadId).sort()).toEqual(["one", "two"]);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it("preserves nonsecret model IDs while redacting assigned environment and nested configuration credentials", async () => {
    const { facade, native, emit } = await fixture("fixture", { CLINE_MODEL: "preserved-model", PROVIDER_KEY: "secret-env-token" }, { endpoint: { token: "secret-config-token" } });
    native.models.options.push({ id: "preserved-model", label: "preserved-model" });
    await facade.refreshModels!();
    expect(facade.models.options.some((model) => model.id === "preserved-model")).toBe(true);
    const events: RuntimeEvent[] = [];
    facade.adapter.onEvent((event) => events.push(event));
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Hello" });
    emit({ type: "runtime.notice", message: "preserved-model secret-env-token secret-config-token" });
    expect(events.find((event) => event.type === "runtime.notice")).toMatchObject({ message: "preserved-model [redacted] [redacted]" });
  });

  it("creates and operates the driver behind the facade and refreshes getter state", async () => {
    const { facade, native, driver } = await fixture();
    expect(driver.decodeConfig).toHaveBeenCalledWith({ value: "kept" });
    expect(driver.create).toHaveBeenCalledOnce();
    expect(await facade.snapshot()).toMatchObject({ state: "available", authenticated: true });
    await facade.refreshModels!();
    expect(facade.models.options.map((option) => option.id)).toEqual(["one", "two"]);
    expect(facade.adapter.enginePid).toBeUndefined();
    expect(facade.generateText).toBeUndefined();
    expect(facade.adapter.cacheKeepWarm).toBeUndefined();
    await facade.dispose();
    expect(native.dispose).toHaveBeenCalled();
  });

  it("reads current approval at each tool gate and never sends guest PIDs to admission", async () => {
    const { facade, turn } = await fixture();
    let mode: "full" | "ask" = "full";
    const admission = vi.fn(async () => {});
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Hello", approvalModeNow: () => mode, engineAdmission: admission });
    expect(admission).toHaveBeenCalledWith("process");
    expect(await turn().approvalModeNow!()).toBe("full");
    mode = "ask";
    expect(await turn().approvalModeNow!()).toBe("ask");
    expect(facade.adapter.hasSession("thread")).toBe(true);
  });

  it("revokes callbacks and emits a terminal event before removing the whole worker on stop", async () => {
    const { facade, turn } = await fixture();
    const events: RuntimeEvent[] = [];
    facade.adapter.onEvent((event) => events.push(event));
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Hello" });
    await facade.adapter.interruptTurn("thread", "turn");
    expect(events.some((event) => event.type === "turn.completed" && !event.ok)).toBe(true);
    await expect(turn().approvalModeNow!()).rejects.toThrow("ended");
    expect(await facade.adapter.respondToRequest("thread", "old", { behavior: "allow" })).toBe("unavailable");
  });

  it("preserves streamed events and binds approval answers to the active thread", async () => {
    const { facade, emit, native } = await fixture();
    const events: RuntimeEvent[] = [];
    facade.adapter.onEvent((event) => events.push(event));
    await facade.adapter.sendTurn({ botId: "bot", threadId: "thread", text: "Hello" });
    emit({ type: "content.delta", streamKind: "assistant_text", delta: "Hello" });
    emit({ type: "request.opened", requestId: "ask", requestType: "permission", tool: "write", summary: "Write a file" });
    expect(await facade.adapter.respondToRequest("other", "ask", { behavior: "allow" })).toBe("unavailable");
    expect(await facade.adapter.respondToRequest("thread", "ask", { behavior: "allow" })).toBe("allowed-once");
    expect(native.adapter.respondToRequest).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "content.delta")).toMatchObject({ providerInstanceId: "engine", botId: "bot", delta: "Hello" });
  });
});
