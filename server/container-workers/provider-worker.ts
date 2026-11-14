import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { AnyProviderDriver, ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { validateWorkerEnvironment } from "./environment.ts";
import { workerIpcDirectory } from "./ipc.ts";
import { FRAME_BYTES, fromWireError, MAX_PENDING, RPC_TIMEOUT_MS, wireError, WorkerChannel, WORKER_PROTOCOL, type WorkerFrame } from "./protocol.ts";

const id = z.string().min(1).max(256);
const initializeSchema = z.object({ botId: id, driverKind: id, input: z.object({ instanceId: id, displayName: z.string().optional(), environment: z.record(z.string(), z.string()), enabled: z.boolean(), config: z.unknown() }).strict() }).strict();
const imageSchema = z.object({ path: z.string().min(1), mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), bytes: z.number().nonnegative().finite(), source: z.literal("video-frame").optional() }).strict();
const sendSchema = z.object({ scope: id, coordination: z.boolean(), turn: z.object({ threadId: id, botId: id, text: z.string(), approvalMode: z.enum(APPROVAL_MODES).optional(), images: z.array(imageSchema).optional() }).passthrough() }).strict();
const threadSchema = z.object({ threadId: id, turnId: id.optional() }).strict();
const responseSchema = z.object({ threadId: id, requestId: id, decision: z.object({ behavior: z.enum(["allow", "deny", "answer"]), message: z.string().optional(), always: z.boolean().optional() }).strict() }).strict();
const steerSchema = z.object({ threadId: id, text: z.string(), images: z.array(imageSchema).optional() }).strict();
interface TurnScope { id: string; threadId: string; active: boolean; turnId?: string; server?: Server; sockets: Set<Socket>; path?: string }
interface Callback { scope: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export interface ProviderWorkerOptions {
  input?: Readable;
  output?: Writable;
  loadDrivers?: () => Promise<readonly AnyProviderDriver[]>;
  onClose?: () => void;
}

/** One provider, whose driver creation and all callbacks live in the worker's filesystem namespace. */
export function runProviderWorker(options: ProviderWorkerOptions = {}): void {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const loadDrivers = options.loadDrivers ?? (async () => (await import("../drivers/builtIn.ts")).BUILT_IN_DRIVERS);
  const scopes = new Map<string, TurnScope>();
  const callbacks = new Map<string, Callback>();
  const requests = new Set<string>();
  let generation: string | undefined, instance: ProviderInstance | undefined, botId: string | undefined;
  let initializing = false, stopped = false, inflight = 0, sequence = 0;
  const closeScope = (scope: TurnScope) => {
    scope.active = false;
    for (const socket of scope.sockets) socket.destroy();
    scope.sockets.clear(); scope.server?.close();
    if (scope.path) { try { unlinkSync(scope.path); } catch {} }
    for (const [id, pending] of callbacks) if (pending.scope === scope.id) { clearTimeout(pending.timer); callbacks.delete(id); pending.reject(new Error("Container turn ended")); }
  };
  const close = () => {
    if (stopped) return;
    stopped = true; channel.close();
    for (const scope of scopes.values()) closeScope(scope);
    for (const pending of callbacks.values()) { clearTimeout(pending.timer); pending.reject(new Error("Container worker stopped")); }
    callbacks.clear();
    void instance?.dispose().catch(() => {});
    if (options.onClose) options.onClose(); else process.exit(0);
  };
  const state = () => ({ models: instance!.models, modelsUnconfirmed: instance!.modelsUnconfirmed, capabilities: instance!.adapter.capabilities });
  const send = (frame: WorkerFrame) => channel.send(frame);
  const callback = (scope: TurnScope, kind: "approval" | "admission" | "coordination", payload: unknown): Promise<unknown> => {
    if (!scope.active || stopped) return Promise.reject(new Error("Container turn ended"));
    if (callbacks.size >= MAX_PENDING) return Promise.reject(new Error("Container callback limit reached"));
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { callbacks.delete(id); reject(new Error("Container callback timed out")); }, RPC_TIMEOUT_MS); timer.unref();
      callbacks.set(id, { scope: scope.id, resolve, reject, timer });
      send({ kind: "callback", version: WORKER_PROTOCOL, generation: generation!, id, scope: scope.id, callback: kind, payload });
    });
  };
  const coordination = async (scope: TurnScope): Promise<NonNullable<SendTurnInput["integrations"]>["agents"]> => {
    const path = join(workerIpcDirectory() ?? tmpdir(), `omb-agents-${randomUUID()}.sock`);
    const server = createServer((socket) => {
      if (!scope.active || scope.sockets.size >= 16) { socket.destroy(); return; }
      scope.sockets.add(socket);
      let buffer = Buffer.alloc(0), pending = 0;
      socket.on("data", (chunk: Buffer) => {
        if (buffer.length + chunk.length > FRAME_BYTES) { socket.destroy(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        let end: number;
        while ((end = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (++pending > 16) { socket.destroy(); return; }
          let message: unknown;
          try { message = JSON.parse(line.toString("utf8")); } catch { socket.destroy(); return; }
          void callback(scope, "coordination", message).then((response) => {
            if (response === null || socket.destroyed) return;
            const wire = `${JSON.stringify(response)}\n`;
            if (Buffer.byteLength(wire) > FRAME_BYTES || socket.writableLength > FRAME_BYTES) socket.destroy();
            else socket.write(wire);
          }, () => { socket.destroy(); }).finally(() => { pending--; });
        }
      });
      socket.on("error", () => { socket.destroy(); });
      socket.on("close", () => { scope.sockets.delete(socket); });
    });
    scope.server = server; scope.path = path;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    return { command: process.execPath, args: [join(SERVER_ROOT, "container-workers", "mcp-client.mjs")], env: { OMB_BRIDGE_SOCKET: path } };
  };
  const event = (event: RuntimeEvent) => {
    const scope = scopes.get(event.threadId);
    if (!scope || stopped) return;
    if (event.turnId && scope.turnId && event.turnId !== scope.turnId) return;
    if (event.turnId && !scope.turnId) scope.turnId = event.turnId;
    if (!scope.active && !["turn.completed", "runtime.error", "request.resolved", "session.exited"].includes(event.type)) return;
    send({ kind: "event", version: WORKER_PROTOCOL, generation: generation!, scope: scope.id, event: event as unknown as Record<string, unknown> });
    if (event.type === "turn.completed") closeScope(scope);
  };
  const dispatch = async (frame: Extract<WorkerFrame, { kind: "request" }>) => {
    if (requests.has(frame.id) || requests.size >= 100_000 || inflight >= MAX_PENDING) { close(); return; }
    requests.add(frame.id); inflight++;
    try {
      let value: unknown = null;
      if (frame.operation === "initialize") {
        if (initializing || instance) throw new Error("Container provider already initialized");
        initializing = true;
        const init = initializeSchema.parse(frame.payload);
        botId = init.botId;
        validateWorkerEnvironment(init.input.environment);
        for (const [key, value] of Object.entries(init.input.environment)) process.env[key] = value;
        const environment = { ...init.input.environment };
        if (init.driverKind === "codex") {
          if (!process.env.HOME) throw new Error("Container worker HOME is missing");
          environment.CODEX_HOME = join(process.env.HOME, ".codex");
          process.env.CODEX_HOME = environment.CODEX_HOME;
        }
        const drivers = await loadDrivers();
        const driver = drivers.find((candidate) => candidate.driverKind === init.driverKind);
        if (!driver) throw new Error("Unknown container driver");
        const config = init.input.config === undefined ? driver.defaultConfig() : driver.decodeConfig(init.input.config);
        instance = await driver.create({ ...init.input, displayName: init.input.displayName, environment, config });
        instance.adapter.onEvent(event);
      } else {
        if (!instance) throw new Error("Container provider is not initialized");
        switch (frame.operation) {
          case "snapshot": value = await instance.snapshot(); break;
          case "refreshModels": await instance.refreshModels?.(); break;
          case "sendTurn": {
            const { scope: scopeId, turn, coordination: bridge } = sendSchema.parse(frame.payload);
            if (turn.botId !== botId || scopes.get(turn.threadId)?.active || [...scopes.values()].some((item) => item.id === scopeId)) throw new Error("Container turn identity refused");
            const scope: TurnScope = { id: scopeId, threadId: turn.threadId, active: true, sockets: new Set() };
            scopes.set(turn.threadId, scope);
            const agents = bridge ? await coordination(scope) : undefined;
            try {
              value = await instance.adapter.sendTurn({ ...(turn as SendTurnInput), integrations: agents ? { agents } : {},
                approvalModeNow: async () => z.enum(APPROVAL_MODES).parse(await callback(scope, "approval", null)),
                engineAdmission: async (start) => { await callback(scope, "admission", start); },
              });
              const started = value as { turnId: string };
              if (scope.turnId && scope.turnId !== started.turnId) throw new Error("Container native turn identity mismatch");
              scope.turnId = started.turnId;
            } catch (error) { closeScope(scope); throw error; }
            break;
          }
          case "interruptTurn": {
            const args = threadSchema.parse(frame.payload);
            const scope = scopes.get(args.threadId);
            if (scope && (!args.turnId || !scope.turnId || scope.turnId === args.turnId)) closeScope(scope);
            await instance.adapter.interruptTurn(args.threadId, args.turnId); break;
          }
          case "respondToRequest": {
            const args = responseSchema.parse(frame.payload);
            value = scopes.get(args.threadId)?.active ? await instance.adapter.respondToRequest(args.threadId, args.requestId, args.decision) : "unavailable"; break;
          }
          case "steer": {
            const args = steerSchema.parse(frame.payload);
            value = scopes.get(args.threadId)?.active && instance.adapter.steer ? await instance.adapter.steer(args.threadId, args.text, args.images) : "refused"; break;
          }
          case "stopAll": for (const scope of scopes.values()) closeScope(scope); await instance.adapter.stopAll(); break;
          case "dispose": for (const scope of scopes.values()) closeScope(scope); await instance.dispose(); break;
        }
      }
      if (!stopped) send({ kind: "response", version: WORKER_PROTOCOL, generation: generation!, id: frame.id, value: { value, state: state() } });
    } catch (error) {
      if (!stopped) send({ kind: "response", version: WORKER_PROTOCOL, generation: generation!, id: frame.id, error: wireError(error) });
    } finally { inflight--; }
  };
  const channel = new WorkerChannel(input, output, (frame) => {
    if (generation === undefined) {
      if (frame.kind !== "request" || frame.operation !== "initialize") throw new Error("Expected worker initialization");
      generation = frame.generation;
    }
    if (generation !== frame.generation) throw new Error("Container generation mismatch");
    if (frame.kind === "request") void dispatch(frame).catch(close);
    else if (frame.kind === "callbackResult") {
      const pending = callbacks.get(frame.id);
      if (!pending) return;
      callbacks.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) pending.reject(fromWireError(frame.error)); else pending.resolve(frame.value);
    } else throw new Error("Unauthorized coordinator frame");
  }, close);
}
