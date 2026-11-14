import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, [process.env.FIXTURE_BASE_ACP, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.pipe(process.stdout);
child.on("exit", (code) => process.exit(code ?? 1));
const waiting = new Map();
let sequence = 0;
const ask = (method, params) => new Promise((resolve) => {
  const id = `filesystem-fixture-${++sequence}`;
  waiting.set(id, resolve);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const frame = JSON.parse(line);
  if (waiting.has(frame.id)) { waiting.get(frame.id)(frame); waiting.delete(frame.id); return; }
  if (frame.method === "session/prompt") {
    const sessionId = frame.params.sessionId;
    const insideRead = await ask("fs/read_text_file", { sessionId, path: process.env.FIXTURE_INSIDE_READ });
    const outsideRead = await ask("fs/read_text_file", { sessionId, path: process.env.FIXTURE_OUTSIDE_READ });
    const insideWrite = await ask("fs/write_text_file", { sessionId, path: process.env.FIXTURE_INSIDE_WRITE, content: "worker callback wrote this" });
    const outsideWrite = await ask("fs/write_text_file", { sessionId, path: process.env.FIXTURE_OUTSIDE_WRITE, content: "must not be written" });
    writeFileSync(process.env.FIXTURE_FS_RECEIPT, JSON.stringify({ insideRead, outsideRead, insideWrite, outsideWrite }));
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());
