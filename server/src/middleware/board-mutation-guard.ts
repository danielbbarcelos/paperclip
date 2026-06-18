import type { Request, RequestHandler } from "express";
import type { DeploymentMode } from "@paperclipai/shared";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build the set of browser origins trusted for board (session-cookie) mutations
 * from SERVER-SIDE configuration only — never from the request's own Host /
 * X-Forwarded-Host headers, which a client (or a misconfigured proxy that
 * forwards client headers) can spoof to defeat the CSRF check.
 *
 * Sources: built-in dev origins, the explicit PAPERCLIP_PUBLIC_URL, and (in
 * authenticated mode) the configured allowedHostnames with port variants.
 * Mirrors deriveAuthTrustedOrigins in auth/better-auth.ts.
 */
export function buildTrustedBoardOrigins(opts: {
  allowedHostnames: string[];
  port: number;
  deploymentMode: DeploymentMode;
}): Set<string> {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));

  const publicUrl = parseOrigin(process.env.PAPERCLIP_PUBLIC_URL?.trim());
  if (publicUrl) origins.add(publicUrl);

  if (opts.deploymentMode === "authenticated") {
    const needsPortVariants = opts.port !== 80 && opts.port !== 443;
    for (const hostname of opts.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      origins.add(`https://${trimmed}`);
      origins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        origins.add(`https://${trimmed}:${opts.port}`);
        origins.add(`http://${trimmed}:${opts.port}`);
      }
    }
  }

  return origins;
}

function isTrustedBoardMutationRequest(req: Request, allowedOrigins: Set<string>) {
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(options: { trustedOrigins: Set<string> }): RequestHandler {
  const allowedOrigins = options.trustedOrigins;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode, board bearer keys, and trusted Cloud tenant calls are
    // not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    if (
      req.actor.source === "local_implicit"
      || req.actor.source === "board_key"
      || req.actor.source === "cloud_tenant"
    ) {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req, allowedOrigins)) {
      res.status(403).json({
        error:
          "Board mutation requires a trusted browser origin. Ensure the request "
          + "Origin matches PAPERCLIP_PUBLIC_URL or PAPERCLIP_ALLOWED_HOSTNAMES.",
      });
      return;
    }

    next();
  };
}
