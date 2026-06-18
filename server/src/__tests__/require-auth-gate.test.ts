import { describe, expect, it } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { requireAuthGate } from "../middleware/require-auth-gate.js";

type TestActor = { type: "board" | "agent" | "none"; source?: string };

function buildApp(actor: TestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  // Mirror app.ts: gate lives inside the /api router.
  const api = Router();
  api.use(requireAuthGate());
  const ok = (_req: express.Request, res: express.Response) => res.status(200).json({ ok: true });
  api.get("/health/status", ok);
  api.get("/openapi.json", ok);
  api.get("/board-claim/:token", ok);
  api.post("/cli-auth/challenges", ok);
  api.get("/cli-auth/challenges/:id", ok);
  api.post("/cli-auth/challenges/:id/cancel", ok);
  api.get("/invites/:token", ok);
  api.get("/invites/:token/onboarding.txt", ok);
  api.post("/invites/:token/accept", ok);
  api.post("/join-requests/:id/claim-api-key", ok);
  api.get("/companies/:id/issues", ok); // protected
  api.post("/companies/:id/secrets", ok); // protected
  app.use("/api", api);
  return app;
}

describe("requireAuthGate", () => {
  const PUBLIC = [
    ["get", "/api/health/status"],
    ["get", "/api/openapi.json"],
    ["get", "/api/board-claim/tok123"],
    ["post", "/api/cli-auth/challenges"],
    ["get", "/api/cli-auth/challenges/abc"],
    ["post", "/api/cli-auth/challenges/abc/cancel"],
    ["get", "/api/invites/tok123"],
    ["get", "/api/invites/tok123/onboarding.txt"],
    ["post", "/api/invites/tok123/accept"],
    ["post", "/api/join-requests/req1/claim-api-key"],
  ] as const;

  it("allows anonymous access to every public endpoint", async () => {
    const app = buildApp({ type: "none", source: "none" });
    for (const [method, path] of PUBLIC) {
      const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it("rejects anonymous access to protected endpoints with 401", async () => {
    const app = buildApp({ type: "none", source: "none" });
    const a = await request(app).get("/api/companies/c1/issues");
    expect(a.status).toBe(401);
    const b = await request(app).post("/api/companies/c1/secrets").send({});
    expect(b.status).toBe(401);
  });

  it("lets authenticated board and agent actors through to protected routes", async () => {
    for (const actor of [
      { type: "board", source: "session" } as const,
      { type: "agent", source: "agent_key" } as const,
    ]) {
      const app = buildApp(actor);
      const res = await request(app).get("/api/companies/c1/issues");
      expect(res.status).toBe(200);
    }
  });

  it("never blocks OPTIONS preflight", async () => {
    const app = buildApp({ type: "none", source: "none" });
    const res = await request(app).options("/api/companies/c1/issues");
    // Express answers OPTIONS automatically; the gate must not turn it into 401.
    expect(res.status).not.toBe(401);
  });
});
