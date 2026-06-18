import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, rateLimitMiddleware } from "../middleware/rate-limit.js";

describe("createRateLimiter", () => {
  it("allows up to maxRequests then blocks within the window", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3, now: () => t });
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const third = limiter.consume("k");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = limiter.consume("k");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates buckets per key", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1, now: () => t });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1, now: () => t });
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(false);
    t += 1001;
    expect(limiter.consume("k").allowed).toBe(true);
  });
});

describe("rateLimitMiddleware", () => {
  function mockRes() {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      status: vi.fn(function (this: Response) {
        return this;
      }),
      json: vi.fn(function (this: Response) {
        return this;
      }),
    } as unknown as Response & { setHeader: ReturnType<typeof vi.fn> };
    return { res, headers };
  }

  it("skips rate limiting when keyFn returns null", () => {
    const mw = rateLimitMiddleware({ windowMs: 1000, maxRequests: 1, keyFn: () => null });
    const next = vi.fn();
    const { res } = mockRes();
    mw({ method: "GET" } as Request, res, next);
    mw({ method: "GET" } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("returns 429 with Retry-After once the limit is exceeded", () => {
    let t = 0;
    const mw = rateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 1,
      keyFn: () => "fixed",
      now: () => t,
      message: "nope",
    });
    const next = vi.fn();
    const a = mockRes();
    mw({ method: "POST" } as Request, a.res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const b = mockRes();
    const status = b.res.status as unknown as ReturnType<typeof vi.fn>;
    const json = b.res.json as unknown as ReturnType<typeof vi.fn>;
    mw({ method: "POST" } as Request, b.res, next);
    expect(next).toHaveBeenCalledTimes(1); // not advanced
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: "nope" }));
    expect(b.headers["Retry-After"]).toBeDefined();
  });
});
