import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { allowsTool } from "../../shared/tool-scope.ts";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import type { DriverCreateInput, ModelCatalog, ProviderAdapter, ProviderInstance, ProviderSnapshot, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "../contracts.ts";
import { agentsMcp } from "../drivers/agents-mcp.ts";
import type { Json } from "../drivers/agents-client.ts";
import { redactSecretsInText } from "../redact.ts";
import { fromWireError, parseWorkerEvent, MAX_PENDING, RPC_TIMEOUT_MS, wireError, WorkerChannel, WORKER_PROTOCOL, type WorkerFrame, type WorkerOperation } from "./protocol.ts";

const modelsSchema = z.object({ default: z.string().max(1024), options: z.array(z.object({ id: z.string().max(1024), label: z.string().max(4096) }).passthrough()).max(10_000) });
const stateSchema = z.object({ models: modelsSchema, modelsUnconfirmed: z.boolean().optional(), capabilities: z.record(z.string(), z.unknown()) }).strict();
export type ProviderWorkerState = z.infer<typeof stateSchema>;
const resultSchema = z.object({ value: z.unknown().optional(), state: stateSchema }).strict();
const snapshotSchema = z.object({ state: z.enum(["available", "unavailable"]), reason: z.string().optional(), authenticated: z.boolean().optional(), version: z.string().nullable().optional(), account: z.object({ email: z.string().optional(), organization: z.string().optional(), method: z.enum(["login", "api-key"]).optional() }).strict().optional() }).passthrough();
const eventTypes = new Set(["session.started", "session.model-variants", "session.exited", "turn.started", "turn.retrying", "turn.completed", "turn.wait_started", "turn.wait_ended", "item.started", "item.updated", "item.output", "turn.progress", "item.completed", "content.delta", "request.opened", "request.resolved", "thread.token-usage.updated", "runtime.error", "runtime.notice", "context.compacted"]);
const eventSchema = z.object({ type: z.string(), eventId: z.string().min(1).max(256), threadId: z.string().min(1).max(256), provider: z.string().max(256), providerInstanceId: z.string().max(256).optional(), createdAt: z.string().max(100), turnId: z.string().max(256).optional(), requestId: z.string().max(256).optional() }).passthrough();
const coordinationMethods = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
const coordinationTools = new Set(["coordinate_bots", "assignment_status"]);

interface Scope {
  id: string;
  input: SendTurnInput;
  active: boolean;
  completed: boolean;
  turnId?: string;
  requests: Set<string>;
  coordination?: ReturnType<typeof agentsMcp>;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface ContainerProviderOptions {
  botId: string;
  driverKind: string;
  input: DriverCreateInput<unknown>;
  spawn(): ChildProcessWithoutNullStreams;
  validateTurn?(turn: SendTurnInput): void;
}

function confinedCapabilities(value: Record<string, unknown>): ProviderAdapter["capabilities"] {
  const result: ProviderAdapter["capabilities"] = { sessionModelSwitch: value.sessionModelSwitch === "in-session" ? "in-session" : "unsupported" };
  for (const key of ["agentsMcp", "images", "nativeImageInput", "modelVariants", "queueing", "steerImages", "strictResume", "engineAdmission"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
  const askTool = z.discriminatedUnion("kind", [z.object({ kind: z.literal("native"), name: z.string().min(1).max(1024) }), z.object({ kind: z.literal("mcp"), server: z.string().min(1).max(32), name: z.string().min(1).max(1024) })]).safeParse(value.askTool);
  if (askTool.success) result.askTool = askTool.data;
  if (value.guestTurns === "confined") result.guestTurns = "confined";
  if (value.contextReading === "meter") result.contextReading = "meter";
  if (Array.isArray(value.effortLevels) && value.effortLevels.every((level) => ["none", "low", "medium", "high", "xhigh", "max"].includes(String(level)))) result.effortLevels = value.effortLevels as NonNullable<typeof result.effortLevels>;
  return { ...result, browserMcp: false, computerMcp: false, localComputerMcp: false, customMcp: false, composioMcp: false, phoneMcp: false, dataMcp: false, emailMcp: false, deviceMcp: false, hooks: false };
}

export class WorkerCleanupError extends Error {
  override readonly name = "WorkerCleanupError";
}
interface ProviderGeneration extends ProviderInstance {
  alive(): boolean;
  terminate(): Promise<void>;
}

async function createProviderGeneration(options: ContainerProviderOptions, signal: AbortSignal): Promise<ProviderGeneration> {
  signal.throwIfAborted();
  const generation = randomUUID();
  const pending = new Map<string, Pending>();
  const scopes = new Map<string, Scope>();
  const threads = new Map<string, Scope>();
  const sessions = new Set<string>();
  const listeners = new Set<RuntimeEventListener>();
  const callbackIds = new Set<string>();
  let callbacks = 0, sequence = 0, dead = false;
  let state: ProviderWorkerState = { models: { default: "", options: [] }, capabilities: {} };
  const sensitive = /key|token|secret|password|credential|auth|cookie/i;
  const selectedSecrets = Object.entries(options.input.environment).flatMap(([key, value]) => sensitive.test(key) ? [value] : []);
  const collectSecrets = (value: unknown, secret = false, depth = 0): void => {
    if (depth > 40) throw new Error("Container configuration exceeds its nesting limit");
    if (typeof value === "string" && secret) selectedSecrets.push(value);
    else if (Array.isArray(value)) for (const item of value) collectSecrets(item, secret, depth + 1);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collectSecrets(item, secret || sensitive.test(key), depth + 1);
  };
  collectSecrets(options.input.config);
  const secrets = [...new Set(selectedSecrets.filter((value) => value.length >= 6))].sort((a, b) => b.length - a.length);
  const child = options.spawn();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
  });
  const confirmClosed = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorkerCleanupError("Container cleanup did not finish; restart is blocked")), 25_000); timer.unref();
      })]);
      if (result.signal || result.code === null || result.code === 70) throw new WorkerCleanupError("Container cleanup could not be confirmed; restart is blocked");
    } finally { if (timer) clearTimeout(timer); }
  };
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecretsInText(secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value));
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  };
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) { try { listener(event); } catch {} } };
  const retire = (scope: Scope) => { scope.active = false; scope.requests.clear(); };
  const fail = (error: Error) => {
    if (dead) return;
    dead = true; channel.close(); child.stdin.end(); child.kill("SIGTERM");
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); sessions.clear();
    for (const scope of scopes.values()) {
      if (scope.completed) continue;
      retire(scope); scope.completed = true;
      const base = { eventId: randomUUID(), provider: options.driverKind, providerInstanceId: options.input.instanceId, threadId: scope.input.threadId, turnId: scope.turnId, createdAt: new Date().toISOString() };
      emit({ ...base, type: "runtime.error", message: "The isolated engine stopped. Start a new turn to retry.", terminal: true });
      emit({ ...base, eventId: randomUUID(), type: "turn.completed", ok: false, stopReason: "worker_stopped" });
    }
  };
  const send = (frame: WorkerFrame) => channel.send(frame);
  const request = (operation: WorkerOperation, payload: unknown): Promise<unknown> => {
    if (dead) return Promise.reject(new Error("Container worker is unavailable"));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Container worker request limit reached"));
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Container worker request timed out")), RPC_TIMEOUT_MS);
      timer.unref(); pending.set(id, { resolve, reject, timer });
      try { send({ kind: "request", version: WORKER_PROTOCOL, generation, id, operation, payload }); } catch (error) { fail(error instanceof Error ? error : new Error("Container transport failed")); }
    });
  };
  const callback = async (frame: Extract<WorkerFrame, { kind: "callback" }>) => {
    if (callbackIds.has(frame.id) || callbacks >= 16) throw new Error("Container callback limit or replay");
    callbackIds.add(frame.id); callbacks++;
    if (callbackIds.size > 100_000) throw new Error("Container callback lifetime limit reached");
    const scope = scopes.get(frame.scope);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!scope?.active || threads.get(scope.input.threadId) !== scope) throw new Error("Container turn capability expired");
      const run = async () => {
        switch (frame.callback) {
          case "approval": return z.enum(APPROVAL_MODES).parse(await scope.input.approvalModeNow?.() ?? scope.input.approvalMode ?? "ask");
          case "admission": {
            const start = z.enum(["process", "session"]).parse(frame.payload);
            await scope.input.engineAdmission?.(start); return null;
          }
          case "coordination": {
            if (!scope.coordination) throw new Error("Container coordination is unavailable");
            const message = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(256), z.number().finite(), z.null()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).strict().parse(frame.payload);
            if (!coordinationMethods.has(message.method)) throw new Error("Container coordination method refused");
            if (message.method === "tools/call") {
              const name = message.params?.name;
              if (typeof name !== "string" || !coordinationTools.has(name) || !allowsTool(scope.input.toolScope, { kind: "mcp", server: "agents", name }, message.params?.arguments)) throw new Error("Container coordination tool refused");
            }
            const response = await scope.coordination(message as Json);
            if (response && message.method === "tools/list") {
              const result = response.result as { tools?: { name: string }[] };
              if (result?.tools) result.tools = result.tools.filter((tool) => coordinationTools.has(tool.name) && allowsTool(scope.input.toolScope, { kind: "mcp", server: "agents", name: tool.name }));
            }
            return response ?? null;
          }
        }
      };
      const value = await Promise.race([run(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Container callback timed out")), RPC_TIMEOUT_MS); timer.unref(); })]);
      if (!dead && scope.active) send({ kind: "callbackResult", version: WORKER_PROTOCOL, generation, id: frame.id, value });
      else if (!dead) send({ kind: "callbackResult", version: WORKER_PROTOCOL, generation, id: frame.id, error: wireError(new Error("Container turn capability expired")) });
    } catch (error) {
      if (!dead) send({ kind: "callbackResult", version: WORKER_PROTOCOL, generation, id: frame.id, error: wireError(error) });
    } finally { if (timer) clearTimeout(timer); callbacks--; }
  };
  const channel = new WorkerChannel(child.stdout, child.stdin, (frame) => {
    if (frame.generation !== generation) throw new Error("Container worker generation mismatch");
    if (frame.kind === "response") {
      const entry = pending.get(frame.id);
      if (!entry) throw new Error("Unexpected container response");
      pending.delete(frame.id); clearTimeout(entry.timer);
      if (frame.error) { entry.reject(fromWireError(sanitize(frame.error) as NonNullable<typeof frame.error>)); return; }
      try { const result = resultSchema.parse(sanitize(frame.value)); state = result.state; entry.resolve(result.value); }
      catch { entry.reject(new Error("Invalid container response")); throw new Error("Invalid container response"); }
    } else if (frame.kind === "callback") {
      void callback(frame).catch((error: unknown) => fail(error instanceof Error ? error : new Error("Invalid container callback")));
    } else if (frame.kind === "event") {
      const scope = scopes.get(frame.scope);
      if (!scope || threads.get(scope.input.threadId) !== scope) throw new Error("Unexpected container event scope");
      const event = eventSchema.parse(parseWorkerEvent(sanitize(frame.event)));
      if (event.threadId !== scope.input.threadId || event.provider !== options.driverKind || (event.providerInstanceId && event.providerInstanceId !== options.input.instanceId) || !eventTypes.has(event.type)) throw new Error("Container event identity or type refused");
      if (event.turnId && scope.turnId && event.turnId !== scope.turnId) throw new Error("Container event turn mismatch");
      if (event.turnId && !scope.turnId) scope.turnId = event.turnId;
      if (scope.completed && event.type !== "session.exited") return;
      if (!scope.active && !["turn.completed", "runtime.error", "request.resolved", "session.exited"].includes(event.type)) return;
      if (event.type === "request.opened") {
        if (!event.requestId || scope.requests.has(event.requestId) || scope.requests.size >= 64) throw new Error("Invalid container approval request");
        scope.requests.add(event.requestId);
      }
      if (event.type === "request.resolved") { if (!event.requestId || !scope.requests.delete(event.requestId)) return; }
      if (event.type === "session.started") sessions.add(event.threadId);
      if (event.type === "session.exited") sessions.delete(event.threadId);
      if (event.type === "turn.completed") { retire(scope); scope.completed = true; }
      const { raw: _raw, ...safe } = event;
      emit({ ...safe, provider: options.driverKind, providerInstanceId: options.input.instanceId, ...(event.type === "content.delta" ? { botId: options.botId } : {}) } as RuntimeEvent);
    } else throw new Error("Container worker sent an unauthorized frame");
  }, fail);
  child.stderr.on("data", () => {});
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Container worker exited")));
  const abort = () => fail(new Error("Container worker generation was stopped"));
  signal.addEventListener("abort", abort, { once: true });
  void closed.then(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  try {
    await request("initialize", { botId: options.botId, driverKind: options.driverKind, input: options.input });
  } catch (error) { fail(error instanceof Error ? error : new Error("Container initialization failed")); await confirmClosed(); throw error; }
  const adapter: ProviderAdapter = {
    provider: options.driverKind,
    get capabilities() { return confinedCapabilities(state.capabilities); },
    async sendTurn(input) {
      if (input.botId !== options.botId) throw new Error("Container policy refuses this bot/engine assignment");
      options.validateTurn?.(input);
      const previous = threads.get(input.threadId);
      if (previous?.active) throw new Error("Container thread already has an active turn");
      if (previous) scopes.delete(previous.id);
      const scope: Scope = { id: randomUUID(), input, active: true, completed: false, requests: new Set(), ...(input.integrations?.agents ? { coordination: agentsMcp({ ...input.integrations.agents.env, OMB_AGENTS_TOOL_BRIDGE: "0" }) } : {}) };
      scopes.set(scope.id, scope); threads.set(input.threadId, scope);
      const { engineAdmission: _admission, approvalModeNow: _approval, integrations: _integrations, ...turn } = input;
      try {
        const value = z.object({ turnId: z.string().min(1).max(256) }).strict().parse(await request("sendTurn", { scope: scope.id, turn, coordination: Boolean(scope.coordination) }));
        if (scope.turnId && scope.turnId !== value.turnId) throw new Error("Container turn result mismatch");
        scope.turnId = value.turnId; return value;
      } catch (error) { retire(scope); throw error; }
    },
    async interruptTurn(threadId, turnId) {
      const scope = threads.get(threadId);
      if (!scope || (turnId && scope.turnId && turnId !== scope.turnId)) return;
      retire(scope);
      await request("interruptTurn", { threadId, ...(turnId ? { turnId } : {}) });
    },
    async respondToRequest(threadId, requestId, decision) {
      const scope = threads.get(threadId);
      if (!scope?.active || !scope.requests.has(requestId)) return "unavailable";
      const result = await request("respondToRequest", { threadId, requestId, decision });
      return z.enum(["allowed-once", "rejected", "answered", "unavailable"]).parse(result);
    },
    async steer(threadId, text, images) {
      const scope = threads.get(threadId);
      if (!scope?.active) return "refused";
      options.validateTurn?.({ ...scope.input, images: images ? [...images] : undefined });
      try { return z.enum(["steered", "refused", "indeterminate"]).parse(await request("steer", { threadId, text, ...(images ? { images } : {}) })); }
      catch { return "indeterminate"; }
    },
    hasSession: (threadId) => !dead && sessions.has(threadId),
    async stopAll() { for (const scope of scopes.values()) retire(scope); await request("stopAll", null); sessions.clear(); },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    instanceId: options.input.instanceId, driverKind: options.driverKind, displayName: options.input.displayName, enabled: options.input.enabled,
    get models() { return state.models as ModelCatalog; },
    get modelsUnconfirmed() { return state.modelsUnconfirmed; },
    adapter,
    async snapshot(): Promise<ProviderSnapshot> { return snapshotSchema.parse(await request("snapshot", null)) as ProviderSnapshot; },
    async refreshModels() { await request("refreshModels", null); },
    alive: () => !dead,
    async terminate() { fail(new Error("Container provider stopped")); await confirmClosed(); },
    async dispose() { fail(new Error("Container provider disposed")); await confirmClosed(); },
  };
}


/** Stable bot identity across worker generations. Stop removes the complete process namespace before reuse. */
export async function createContainerProvider(options: ContainerProviderOptions): Promise<ProviderInstance> {
  const listeners = new Set<RuntimeEventListener>();
  const turns = new Map<string, { generation?: ProviderGeneration; turnId?: string; epoch: number }>();
  let current: ProviderGeneration | undefined;
  let creating: Promise<ProviderGeneration> | undefined;
  let creationAbort: AbortController | undefined;
  let stopping: Promise<void> | undefined;
  let disposed = false, epoch = 0;
  let blocked: WorkerCleanupError | undefined;
  let models: ModelCatalog = { default: "", options: [] };
  let modelsUnconfirmed: boolean | undefined;
  let capabilities: ProviderAdapter["capabilities"] = { sessionModelSwitch: "unsupported" };
  const remember = (instance: ProviderGeneration) => {
    models = instance.models; modelsUnconfirmed = instance.modelsUnconfirmed; capabilities = instance.adapter.capabilities;
  };
  const ensure = async (): Promise<ProviderGeneration> => {
    if (stopping) await stopping;
    if (disposed) throw new Error("Container provider is disposed");
    if (blocked) throw blocked;
    if (current) {
      if (!current.alive()) throw new Error("Container worker is unavailable");
      return current;
    }
    if (!creating) {
      const started = epoch;
      const controller = new AbortController(); creationAbort = controller;
      creating = createProviderGeneration(options, controller.signal).then(async (instance) => {
        if (disposed || epoch !== started) { await instance.terminate(); throw new Error("Container generation was stopped before startup completed"); }
        current = instance; remember(instance);
        instance.adapter.onEvent((event) => {
          if (current !== instance) return;
          const turn = turns.get(event.threadId);
          if (turn && turn.generation !== instance) return;
          if (turn && event.turnId) turn.turnId = event.turnId;
          for (const listener of listeners) { try { listener(event); } catch {} }
        });
        return instance;
      }).catch((error: unknown) => { if (error instanceof WorkerCleanupError) blocked = error; throw error; })
        .finally(() => { creating = undefined; if (creationAbort === controller) creationAbort = undefined; });
    }
    return creating;
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const task = { promise: new Promise<void>((done, failed) => { resolve = done; reject = failed; }), resolve: () => resolve(), reject: (error: unknown) => reject(error) };
    stopping = task.promise;
    const pending = creating;
    epoch++;
    creationAbort?.abort();
    const instance = current;
    let terminating: Promise<void> | undefined;
    if (instance) { remember(instance); terminating = instance.terminate(); current = undefined; }
    const finish = async () => {
      try {
        await terminating;
        if (pending) {
          try { await pending; } catch (error) { if (error instanceof WorkerCleanupError) throw error; }
        }
        if (blocked) throw blocked;
      } catch (error) {
        if (error instanceof WorkerCleanupError) blocked = error;
        throw error;
      } finally { turns.clear(); }
    };
    void finish().then(task.resolve, task.reject).finally(() => { if (stopping === task.promise) stopping = undefined; });
    return task.promise;
  };
  await ensure();
  const adapter: ProviderAdapter = {
    provider: options.driverKind,
    get capabilities() { return current?.adapter.capabilities ?? capabilities; },
    async sendTurn(input) {
      if (input.botId !== options.botId) throw new Error("Container policy refuses this bot/engine assignment");
      options.validateTurn?.(input);
      if (stopping) await stopping;
      const turn = { epoch } as { generation?: ProviderGeneration; turnId?: string; epoch: number };
      turns.set(input.threadId, turn);
      const instance = await ensure();
      if (turn.epoch !== epoch || disposed || stopping) throw new Error("Container turn was stopped before dispatch");
      turn.generation = instance;
      const result = await instance.adapter.sendTurn(input);
      turn.turnId = result.turnId;
      return result;
    },
    async interruptTurn(threadId, turnId) {
      const turn = turns.get(threadId);
      if (!turn || (turnId !== undefined && turn.turnId !== turnId)) return;
      await stop();
    },
    async respondToRequest(threadId, requestId, decision) {
      const turn = turns.get(threadId);
      if (!current?.alive() || stopping || turn?.generation !== current) return "unavailable";
      return current.adapter.respondToRequest(threadId, requestId, decision);
    },
    async steer(threadId, text, images) {
      if (!current?.alive() || stopping || turns.get(threadId)?.generation !== current || !current.adapter.steer) return "refused";
      return current.adapter.steer(threadId, text, images);
    },
    hasSession: (threadId) => !stopping && Boolean(current?.alive() && current.adapter.hasSession(threadId)),
    stopAll: stop,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    instanceId: options.input.instanceId, driverKind: options.driverKind, displayName: options.input.displayName, enabled: options.input.enabled,
    get models() { return current?.models ?? models; },
    get modelsUnconfirmed() { return current?.modelsUnconfirmed ?? modelsUnconfirmed; },
    adapter,
    snapshot: async () => (await ensure()).snapshot(),
    refreshModels: async () => { await (await ensure()).refreshModels?.(); },
    async dispose() { disposed = true; await stop(); listeners.clear(); },
  };
}
