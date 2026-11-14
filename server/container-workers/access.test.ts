import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveRequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";

it("refuses legacy local service routes even when a container appears to originate on loopback", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-worker-access-"));
  try {
    const sessions = new SessionRegistry({ file: join(root, "sessions.json") });
    const admin = sessions.issue({ label: "Operator", scopes: ["admin", "client"] });
    const check = (method: string, path: string, token?: string) => resolveRequestAuth({
      method, headers: { host: "127.0.0.1:8799", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage, { sessions, cookieName: "omb_test", streamPath: "/api/events", url: new URL(path, "http://localhost"), loopbackTrust: "service", isolateWorkers: true });
    for (const [method, path] of [
      ["GET", "/api/bots"], ["GET", "/api/threads/other/messages"], ["GET", "/api/attachments/other.png"],
      ["POST", "/api/bots/other/tasks"], ["POST", "/api/bots/other/messages/guarded"],
      ["POST", "/api/threads/other/respond"], ["POST", "/api/auth/pairing"], ["PATCH", "/api/config"],
    ]) {
      expect(check(method!, path!).auth, path).toBeNull();
      expect(check(method!, path!, admin.token).auth?.kind, path).toBe("session");
    }
    expect(check("GET", "/api/health").auth?.kind).toBe("loopback");
    expect(check("POST", "/api/internal/coordinate-bots").auth).toMatchObject({ kind: "loopback", trust: "service" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
