import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("muse 1.4.6 fixture\n"); process.exit(0); }
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { schema: { fingerprint: "sha256:fixture" }, grantedCapabilities: [] } });
  if (method === "model/list") return send({ id, result: { models: [{ modelId: "muse-fixture", isDefault: true }] } });
  if (method === "session/start") return send({ id, result: { session: { sessionId: "session", modelId: "muse-fixture" } } });
  send({ id, result: { commandId: params.commandId } });
  if (method !== "turn/start") return;
  const { sessionId, commandId: turnId } = params;
  send({ method: "item/completed", params: { sessionId, item: { itemId: "message", kind: "agentMessage", status: "completed", turnId, text: "fixture response" } } });
  send({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } });
});
