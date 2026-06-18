import type { Request, RequestHandler } from "express";

// Default-deny / fail-closed gate for the /api router.
//
// actorMiddleware is fail-open: a request with a bad/absent bearer token is left
// as actor.type "none" and allowed through, so security depends on every one of
// the 40+ route handlers remembering to assert auth. This gate flips that to
// fail-closed: an unauthenticated caller (actor.type "none") is rejected with
// 401 unless the request targets an explicitly public endpoint.
//
// Paths are matched relative to the /api mount (req.path inside the api router),
// i.e. without the leading "/api". The allowlist below is the complete set of
// endpoints intentionally reachable without authentication (token/challenge
// gated in their own handlers). Keep it in sync when adding public routes.

type PublicRoute = { method: string; pattern: RegExp };

const PUBLIC_ROUTES: PublicRoute[] = [
  // Liveness/readiness + API discovery.
  { method: "GET", pattern: /^\/health(\/.*)?$/ },
  { method: "GET", pattern: /^\/openapi\.json$/ },
  // First-boot board ownership claim inspection (token gated).
  { method: "GET", pattern: /^\/board-claim\/[^/]+$/ },
  // CLI auth challenge lifecycle (challenge-secret gated).
  { method: "POST", pattern: /^\/cli-auth\/challenges$/ },
  { method: "GET", pattern: /^\/cli-auth\/challenges\/[^/]+$/ },
  { method: "POST", pattern: /^\/cli-auth\/challenges\/[^/]+\/cancel$/ },
  // Invite preview/onboarding surface (all GET, invite-token gated) and the
  // accept endpoint (agent joins are anonymous; human/bootstrap joins assert
  // auth inline within the handler).
  { method: "GET", pattern: /^\/invites\/[^/]+(\/.*)?$/ },
  { method: "POST", pattern: /^\/invites\/[^/]+\/accept$/ },
  // Agent claims its issued API key after a join request (claim-secret gated).
  { method: "POST", pattern: /^\/join-requests\/[^/]+\/claim-api-key$/ },
];

function isPublicRoute(req: Request): boolean {
  const method = req.method.toUpperCase();
  // Preflight requests carry no credentials and must not be blocked.
  if (method === "OPTIONS") return true;
  const path = req.path;
  return PUBLIC_ROUTES.some(
    (route) => route.method === method && route.pattern.test(path),
  );
}

export function requireAuthGate(): RequestHandler {
  return (req, res, next) => {
    if (req.actor?.type !== "none") {
      next();
      return;
    }
    if (isPublicRoute(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "Authentication required" });
  };
}
