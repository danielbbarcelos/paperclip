import type { Request, RequestHandler } from "express";

// Generic in-memory sliding-window rate limiter, mirroring the proven approach
// in services/company-search-rate-limit.ts but keyed by an arbitrary string so
// it can gate auth, failed-bearer, and expensive-render traffic.

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  consume(key: string): RateLimitResult;
};

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  now?: () => number;
}): RateLimiter {
  const { windowMs, maxRequests } = options;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  return {
    consume(key) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const recentHits = (hitsByKey.get(key) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxRequests) {
        hitsByKey.set(key, recentHits);
        const oldestHit = recentHits[0] ?? currentTime;
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(key, recentHits);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}

export type RateLimitMiddlewareOptions = {
  windowMs: number;
  maxRequests: number;
  /**
   * Returns the bucket key for this request, or null to skip rate limiting
   * (e.g. only count POST requests, or only requests from a given actor).
   */
  keyFn: (req: Request) => string | null;
  message?: string;
  now?: () => number;
};

export function rateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  const limiter = createRateLimiter({
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
    now: options.now,
  });
  const message = options.message ?? "Too many requests";

  return (req, res, next) => {
    const key = options.keyFn(req);
    if (key === null) {
      next();
      return;
    }
    const result = limiter.consume(key);
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({ error: message, retryAfterSeconds: result.retryAfterSeconds });
      return;
    }
    next();
  };
}
