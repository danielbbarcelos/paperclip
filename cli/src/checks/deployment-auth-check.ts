import { inferBindModeFromHost } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function deploymentAuthCheck(config: PaperclipConfig): CheckResult {
  const mode = config.server.deploymentMode;
  const exposure = config.server.exposure;
  const auth = config.auth;
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);

  if (mode === "local_trusted") {
    if (bind !== "loopback") {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: `local_trusted requires loopback binding (found ${bind})`,
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and choose Local trusted / loopback reachability",
      };
    }
    return {
      name: "Deployment/auth mode",
      status: "pass",
      message: "local_trusted mode is configured for loopback-only access",
    };
  }

  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() ??
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!secret) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)",
      canRepair: false,
      repairHint: "Set BETTER_AUTH_SECRET before starting Paperclip",
    };
  }

  if (auth.baseUrlMode === "explicit" && !auth.publicBaseUrl) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "auth.baseUrlMode=explicit requires auth.publicBaseUrl",
      canRepair: false,
      repairHint: "Run `paperclipai configure --section server` and provide a base URL",
    };
  }

  if (exposure === "public") {
    if (auth.baseUrlMode !== "explicit" || !auth.publicBaseUrl) {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "authenticated/public requires explicit auth.publicBaseUrl",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and select public exposure",
      };
    }
    try {
      const url = new URL(auth.publicBaseUrl);
      if (url.protocol !== "https:") {
        return {
          name: "Deployment/auth mode",
          status: "warn",
          message: "Public exposure should use an https:// auth.publicBaseUrl",
          canRepair: false,
          repairHint: "Use HTTPS in production for secure session cookies",
        };
      }
    } catch {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "auth.publicBaseUrl is not a valid URL",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and provide a valid URL",
      };
    }

    // Behind a reverse proxy, req.ip (and per-client rate limiting / auth
    // throttles) is only correct when TRUST_PROXY is set. The server refuses to
    // boot a public deployment that leaves it unset; surface that here as a
    // pre-flight. An explicit 0/false (direct, no-proxy exposure) is allowed.
    const trustProxy = process.env.TRUST_PROXY?.trim();
    if (trustProxy === undefined || trustProxy === "") {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "authenticated/public requires an explicit TRUST_PROXY (hop count / trusted subnet when proxied, or 0 for direct exposure) so per-client rate limiting is correct",
        canRepair: false,
        repairHint: "Set TRUST_PROXY to your reverse proxy's hop count (e.g. 1) or subnet(s), or 0 if exposed directly",
      };
    }

    // Cloud tenant trust-header auth via a shared token is a cross-tenant
    // impersonation primitive over the open internet unless the upstream proxy
    // also signs the identity headers. The server requires the HMAC key in this
    // case; flag it before start.
    if (process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim() && !process.env.PAPERCLIP_CLOUD_TENANT_HMAC_KEY?.trim()) {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN under public exposure also requires PAPERCLIP_CLOUD_TENANT_HMAC_KEY to prevent cross-tenant impersonation",
        canRepair: false,
        repairHint: "Set PAPERCLIP_CLOUD_TENANT_HMAC_KEY and have the upstream proxy sign tenant identity headers",
      };
    }
  }

  return {
    name: "Deployment/auth mode",
    status: "pass",
    message: `Mode ${mode}/${exposure} with bind ${bind} and auth URL mode ${auth.baseUrlMode}`,
  };
}
