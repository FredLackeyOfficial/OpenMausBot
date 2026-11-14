import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { unlinkSync } from "node:fs";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sockets = new Map();
let sequence = 0;
let engine;
const socketPath = process.env.OMB_BRIDGE_SOCKET;
try { unlinkSync(socketPath); } catch {}
const server = createServer((socket) => {
  const channel = String(++sequence);
  sockets.set(channel, socket);
  createInterface({ input: socket }).on("line", (line) => {
    try { send({ bridge: channel, message: JSON.parse(line) }); } catch { socket.destroy(); }
  });
  socket.on("close", () => sockets.delete(channel));
});
await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (message.start && !engine) {
    engine = spawn(message.start[0], message.start.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...message.env } });
    engine.stdout.on("data", (data) => send({ stdout: data.toString("base64") }));
    engine.stderr.on("data", (data) => send({ stderr: data.toString("base64") }));
    engine.on("error", () => process.exit(127));
    engine.on("exit", (code) => process.exit(code ?? 1));
    engine.stdin.on("error", () => {});
  } else if (message.stdin !== undefined) engine?.stdin.write(Buffer.from(message.stdin, "base64"));
  else if (message.end) engine?.stdin.end();
  else if (message.bridge) sockets.get(message.bridge)?.write(`${JSON.stringify(message.message)}\n`);
});
// Exiting PID 1's child makes Docker's init exit, killing every process in this container's PID namespace.
input.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
