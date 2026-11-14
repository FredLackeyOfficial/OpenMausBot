import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { ProviderError, TurnAuthenticationRefusedError, TurnNotStartedError, TurnUsageLimitRefusedError } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";

export const WORKER_PROTOCOL = 1;
export const FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING = 32;
export const RPC_TIMEOUT_MS = 120_000;
const id = z.string().min(1).max(256);
const operation = z.enum(["initialize", "snapshot", "refreshModels", "sendTurn", "interruptTurn", "respondToRequest", "steer", "stopAll", "dispose"]);
const error = z.object({ name: z.string().max(100), message: z.string().max(4096), code: z.string().max(100).optional(), turnId: id.optional(), known: z.boolean().optional(), resetsAt: z.number().finite().optional(), scope: z.enum(["engine", "model", "credits"]).optional() }).strict();
export const frameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), version: z.literal(WORKER_PROTOCOL), generation: id, id, operation, payload: z.unknown() }).strict(),
  z.object({ kind: z.literal("response"), version: z.literal(WORKER_PROTOCOL), generation: id, id, value: z.unknown().optional(), error: error.optional() }).strict(),
  z.object({ kind: z.literal("event"), version: z.literal(WORKER_PROTOCOL), generation: id, scope: id, event: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("callback"), version: z.literal(WORKER_PROTOCOL), generation: id, id, scope: id, callback: z.enum(["approval", "admission", "coordination"]), payload: z.unknown() }).strict(),
  z.object({ kind: z.literal("callbackResult"), version: z.literal(WORKER_PROTOCOL), generation: id, id, value: z.unknown().optional(), error: error.optional() }).strict(),
]);
export type WorkerFrame = z.infer<typeof frameSchema>;
export type WorkerOperation = z.infer<typeof operation>;
export type WireError = z.infer<typeof error>;

export function wireError(value: unknown): WireError {
  const source = value instanceof Error ? value : new Error("Container worker operation failed");
  return { name: source.name, message: redactSecretsInText(source.message).slice(0, 4096),
    ...(source instanceof ProviderError ? { code: source.code } : {}),
    ...(source instanceof TurnNotStartedError ? { turnId: source.turnId } : {}),
    ...(source instanceof TurnAuthenticationRefusedError ? { known: source.known } : {}),
    ...(source instanceof TurnUsageLimitRefusedError ? { known: source.known, resetsAt: source.resetsAt, scope: source.scope } : {}),
  };
}
export function fromWireError(value: WireError): Error {
  if (value.name === "TurnAuthenticationRefusedError" && value.turnId) return new TurnAuthenticationRefusedError(value.turnId, value.message, value.known);
  if (value.name === "TurnUsageLimitRefusedError" && value.turnId) return new TurnUsageLimitRefusedError(value.turnId, value.message, value.resetsAt, value.scope, value.known);
  if (value.name === "TurnNotStartedError" && value.turnId) return new TurnNotStartedError(value.turnId, value.message);
  if (value.name === "ProviderError" && ["missing_cli", "invalid_credentials", "inactive_subscription", "insufficient_funds", "quota_or_region_restriction", "upstream_outage", "model_catalog_outage"].includes(value.code ?? "")) return new ProviderError(value.code as ProviderError["code"], value.message);
  return new Error(value.message);
}

/** Bounded JSON lines; an unterminated or backpressured frame cannot grow memory without limit. */
export class WorkerChannel {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly receive: (frame: WorkerFrame) => void;
  private readonly failed: (error: Error) => void;
  constructor(input: Readable, output: Writable, receive: (frame: WorkerFrame) => void, failed: (error: Error) => void) {
    this.input = input; this.output = output; this.receive = receive; this.failed = failed;
    input.on("data", this.read);
    input.on("error", this.fail);
    input.on("end", this.ended);
    output.on("error", this.fail);
  }
  private ended = () => this.fail(new Error("Container worker transport closed"));
  private fail = (error: Error) => { if (!this.closed) { this.close(); this.failed(error); } };
  private read = (data: Buffer | string) => {
    if (this.closed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let start = 0;
    while (start < chunk.length && !this.closed) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (this.buffer.length + part.length > FRAME_BYTES) return this.fail(new Error("Container worker frame exceeds its limit"));
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      try {
        const parsed: unknown = JSON.parse(this.buffer.toString("utf8"));
        const stack = [{ value: parsed, depth: 0 }];
        let nodes = 0;
        while (stack.length) {
          const { value, depth } = stack.pop()!;
          if (++nodes > 100_000 || depth > 40) throw new Error("Container JSON complexity limit");
          if (value && typeof value === "object") for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
        }
        const frame = frameSchema.parse(parsed);
        this.buffer = Buffer.alloc(0);
        this.receive(frame);
      } catch { return this.fail(new Error("Invalid container worker frame")); }
      start = end + 1;
    }
  };
  send(frame: WorkerFrame): void {
    if (this.closed) throw new Error("Container worker transport closed");
    const line = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (line.length > FRAME_BYTES || this.output.writableLength + line.length > FRAME_BYTES * 2) {
      const failure = new Error("Container worker output exceeds its limit"); this.fail(failure); throw failure;
    }
    this.output.write(line);
  }
  close(): void {
    this.closed = true; this.buffer = Buffer.alloc(0);
    this.input.off("data", this.read); this.input.off("end", this.ended);
    // Keep error listeners attached: a broken pipe after close must not crash the coordinator.
  }
}

const text = z.string();
const number = z.number().finite();
const baseEvent = {
  eventId: id, provider: id, providerInstanceId: id.optional(), threadId: id, createdAt: z.string().max(100),
  turnId: id.optional(), itemId: id.optional(), requestId: id.optional(), synthetic: z.boolean().optional(),
};
const holder = z.object({ name: text, task: text.optional() }).optional();
const usage = z.object({ input: number, output: number, cachedInput: number.optional() });
const modelVariants = z.object({ options: z.array(z.object({ id: text, label: text })), currentValue: text.optional() });
const serverText = z.object({ key: text, params: z.record(z.string(), z.union([text, number])).optional() }).optional();
const runtimeEventSchemas: Record<string, z.ZodType> = {
  "session.started": z.object({ ...baseEvent, type: z.literal("session.started"), sessionId: text.nullable(), model: text.nullable().optional(), rebuilt: z.boolean().optional() }),
  "session.model-variants": z.object({ ...baseEvent, type: z.literal("session.model-variants"), model: text, variants: modelVariants }),
  "session.exited": z.object({ ...baseEvent, type: z.literal("session.exited"), reason: text.optional() }),
  "turn.started": z.object({ ...baseEvent, type: z.literal("turn.started") }),
  "turn.retrying": z.object({ ...baseEvent, type: z.literal("turn.retrying"), attempt: number.int().positive(), delayMs: number.nonnegative(), reason: text }),
  "turn.completed": z.object({ ...baseEvent, type: z.literal("turn.completed"), ok: z.boolean(), stopReason: text.nullable().optional(), cost: number.nullable().optional(), denials: z.array(text).optional(), usage: usage.optional() }),
  "turn.wait_started": z.object({ ...baseEvent, type: z.literal("turn.wait_started"), resource: text, position: number.optional(), holder }),
  "turn.wait_ended": z.object({ ...baseEvent, type: z.literal("turn.wait_ended"), resource: text, waitedMs: number.nonnegative(), outcome: z.enum(["acquired", "gave_up", "parked", "stopped"]), holder }),
  "turn.progress": z.object({ ...baseEvent, type: z.literal("turn.progress"), activity: z.enum(["write", "edit", "command", "web", "read", "fetch", "search", "tool"]), tool: text.optional(), file: text.optional(), bytes: number.optional(), target: text.optional(), detail: text.optional(), quiet: z.discriminatedUnion("kind", [z.object({ kind: z.literal("output"), at: number }), z.object({ kind: z.enum(["network", "busy", "idle"]) })]).optional(), tail: z.array(text).optional() }),
  "item.started": z.object({ ...baseEvent, type: z.literal("item.started"), itemType: z.enum(["tool", "reasoning"]), title: text.optional(), summary: text.optional(), input: text.optional() }),
  "item.updated": z.object({ ...baseEvent, type: z.literal("item.updated"), itemType: z.enum(["tool", "reasoning"]), tokens: number.nullable().optional() }),
  "item.output": z.object({ ...baseEvent, type: z.literal("item.output"), itemType: z.literal("tool"), text, whole: z.boolean().optional() }),
  "item.completed": z.discriminatedUnion("itemType", [
    z.object({ ...baseEvent, type: z.literal("item.completed"), itemType: z.literal("tool"), ok: z.boolean(), output: text.optional() }),
    z.object({ ...baseEvent, type: z.literal("item.completed"), itemType: z.literal("assistant_text"), text }),
    z.object({ ...baseEvent, type: z.literal("item.completed"), itemType: z.literal("assistant_image"), data: text, alt: text.optional(), fromTool: z.literal(true).optional() }),
  ]),
  "content.delta": z.object({ ...baseEvent, type: z.literal("content.delta"), streamKind: z.enum(["assistant_text", "reasoning_text"]), delta: text }),
  "request.opened": z.object({ ...baseEvent, type: z.literal("request.opened"), requestType: z.enum(["permission", "question"]), tool: text, summary: text, summaryCode: text.optional(), summaryParams: z.record(z.string(), z.union([text, number])).optional(), command: z.object({ command: text, cwd: text }).optional(), commandLine: text.optional(), reads: z.array(text).optional(), choices: z.array(text).optional(), questions: z.array(z.object({ question: text, header: text.optional(), multiSelect: z.boolean().optional(), custom: z.literal(false).optional(), options: z.array(z.object({ label: text, description: text.optional() })) })).optional(), origin: z.enum(["tool", "output"]).optional(), approvalScope: z.literal("local-computer").optional(), requiresExplicitApproval: z.boolean().optional(), nativeReview: z.enum(["active", "inactive"]).optional(), allowSession: z.boolean().optional() }),
  "request.resolved": z.object({ ...baseEvent, type: z.literal("request.resolved"), behavior: z.enum(["allow", "deny", "answer"]), source: z.enum(["user", "auto", "timeout", "system", "unavailable", "peer"]), approvalScope: z.literal("local-computer").optional() }),
  "thread.token-usage.updated": z.object({ ...baseEvent, type: z.literal("thread.token-usage.updated"), ...usage.shape, contextTokens: number.optional(), contextWindow: number.optional(), reasoning: number.optional() }),
  "runtime.notice": z.object({ ...baseEvent, type: z.literal("runtime.notice"), message: text, text: serverText }),
  "runtime.error": z.object({ ...baseEvent, type: z.literal("runtime.error"), message: text, text: serverText, partial: z.boolean().optional(), setup: z.boolean().optional(), terminal: z.boolean().optional(), claudeUpdate: z.boolean().optional(), trialCredit: z.enum(["used_up", "ended", "paused", "too_low"]).optional(), stalled: z.boolean().optional(), limitResetsAt: number.optional(), limit: z.enum(["engine", "model", "credits"]).optional(), limitModels: z.array(text).optional() }),
  "context.compacted": z.object({ ...baseEvent, type: z.literal("context.compacted") }),
};

/** Strip unrecognized fields before worker events reach coordinator consumers. */
export function parseWorkerEvent(value: unknown): Record<string, unknown> {
  const kind = z.object({ type: text }).parse(value).type;
  const schema = Object.hasOwn(runtimeEventSchemas, kind) ? runtimeEventSchemas[kind] : undefined;
  if (!schema) throw new Error("Unsupported container event type");
  return schema.parse(value) as Record<string, unknown>;
}
