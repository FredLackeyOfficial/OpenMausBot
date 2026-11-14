import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer synthetic-provider-key") {
    response.writeHead(401); response.end(); return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404); response.end(); return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const listed = body.tools?.find(tool => tool.function?.name?.endsWith("assignment_status"));
  const called = body.messages.some(message => message.role === "tool");
  const delta = listed && !called
    ? { tool_calls: [{ index: 0, id: "assignment-call", type: "function", function: { name: listed.function.name, arguments: "{}" } }] }
    : { content: "fixture response" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: listed && !called ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(18777, "127.0.0.1", resolve));
await import("./container-worker-runtime.js");
