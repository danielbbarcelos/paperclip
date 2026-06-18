import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { actorRateLimitKey, createDestructiveActionRateLimit } from "./rate-limit.js";

function fakeReq(actor: Partial<Request["actor"]>, ip = "1.2.3.4"): Request {
  return { actor: { type: "board", ...actor } as Request["actor"], ip } as unknown as Request;
}

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("actorRateLimitKey", () => {
  it("prefers userId, then agentId, then ip", () => {
    expect(actorRateLimitKey(fakeReq({ userId: "u1" }))).toBe("user:u1");
    expect(actorRateLimitKey(fakeReq({ type: "agent", agentId: "a1" }))).toBe("agent:a1");
    expect(actorRateLimitKey(fakeReq({ type: "none" }))).toBe("ip:1.2.3.4");
  });
});

describe("createDestructiveActionRateLimit", () => {
  it("throttles a single actor after the limit and isolates other actors", () => {
    const mw = createDestructiveActionRateLimit({ windowMs: 60_000, maxRequests: 3 });

    const run = (actorId: string) => {
      const res = fakeRes();
      let nexted = false;
      mw(fakeReq({ userId: actorId }), res, () => {
        nexted = true;
      });
      return { nexted, status: res.statusCode };
    };

    expect(run("u1").nexted).toBe(true);
    expect(run("u1").nexted).toBe(true);
    expect(run("u1").nexted).toBe(true);
    const blocked = run("u1");
    expect(blocked.nexted).toBe(false);
    expect(blocked.status).toBe(429);

    // A different actor has an independent budget.
    expect(run("u2").nexted).toBe(true);
  });
});
