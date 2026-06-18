import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Request } from "express";
import { verifyCloudTenantSignature } from "../middleware/auth.js";

const KEY_ENV = "PAPERCLIP_CLOUD_TENANT_HMAC_KEY";
const REQUIRED_ENV = "PAPERCLIP_CLOUD_TENANT_HMAC_REQUIRED";

const IDENTITY = { userId: "user-1", stackId: "stack-1", stackRole: "owner" };

function sign(key: string, ts: number, identity = IDENTITY): string {
  const payload = `${identity.userId}:${identity.stackId}:${identity.stackRole}:${ts}`;
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function reqWith(headers: Record<string, string | undefined>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe("verifyCloudTenantSignature", () => {
  const original = { key: process.env[KEY_ENV], required: process.env[REQUIRED_ENV] };

  beforeEach(() => {
    delete process.env[KEY_ENV];
    delete process.env[REQUIRED_ENV];
  });

  afterEach(() => {
    if (original.key === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = original.key;
    if (original.required === undefined) delete process.env[REQUIRED_ENV];
    else process.env[REQUIRED_ENV] = original.required;
  });

  it("skips when no signing key is configured (backward compatible)", () => {
    expect(verifyCloudTenantSignature(reqWith({}), IDENTITY)).toBe("skip");
  });

  it("skips an unsigned request when the signature is not required", () => {
    process.env[KEY_ENV] = "secret-key";
    expect(verifyCloudTenantSignature(reqWith({}), IDENTITY)).toBe("skip");
  });

  it("rejects an unsigned request when the signature is required", () => {
    process.env[KEY_ENV] = "secret-key";
    process.env[REQUIRED_ENV] = "true";
    expect(verifyCloudTenantSignature(reqWith({}), IDENTITY)).toBe("invalid");
  });

  it("accepts a correctly signed, fresh request", () => {
    process.env[KEY_ENV] = "secret-key";
    const ts = Math.floor(Date.now() / 1000);
    const req = reqWith({
      "x-paperclip-cloud-timestamp": String(ts),
      "x-paperclip-cloud-signature": sign("secret-key", ts),
    });
    expect(verifyCloudTenantSignature(req, IDENTITY)).toBe("valid");
  });

  it("rejects a signature made with the wrong key", () => {
    process.env[KEY_ENV] = "secret-key";
    const ts = Math.floor(Date.now() / 1000);
    const req = reqWith({
      "x-paperclip-cloud-timestamp": String(ts),
      "x-paperclip-cloud-signature": sign("attacker-key", ts),
    });
    expect(verifyCloudTenantSignature(req, IDENTITY)).toBe("invalid");
  });

  it("rejects a signature bound to a different identity (cross-tenant forgery)", () => {
    process.env[KEY_ENV] = "secret-key";
    const ts = Math.floor(Date.now() / 1000);
    // Signature is valid for victim stack, but the request claims it.
    const victimSig = sign("secret-key", ts, { ...IDENTITY, stackId: "victim-stack" });
    const req = reqWith({
      "x-paperclip-cloud-timestamp": String(ts),
      "x-paperclip-cloud-signature": victimSig,
    });
    expect(verifyCloudTenantSignature(req, IDENTITY)).toBe("invalid");
  });

  it("rejects a stale signature outside the freshness window", () => {
    process.env[KEY_ENV] = "secret-key";
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const req = reqWith({
      "x-paperclip-cloud-timestamp": String(ts),
      "x-paperclip-cloud-signature": sign("secret-key", ts),
    });
    expect(verifyCloudTenantSignature(req, IDENTITY)).toBe("invalid");
  });

  it("rejects a non-numeric timestamp", () => {
    process.env[KEY_ENV] = "secret-key";
    const req = reqWith({
      "x-paperclip-cloud-timestamp": "not-a-number",
      "x-paperclip-cloud-signature": "whatever",
    });
    expect(verifyCloudTenantSignature(req, IDENTITY)).toBe("invalid");
  });

  describe("public exposure (signature mandatory regardless of the REQUIRED flag)", () => {
    it("rejects an unsigned request even when not flagged required", () => {
      process.env[KEY_ENV] = "secret-key";
      expect(
        verifyCloudTenantSignature(reqWith({}), IDENTITY, { deploymentExposure: "public" }),
      ).toBe("invalid");
    });

    it("rejects when no signing key is configured (no insecure fallback)", () => {
      expect(
        verifyCloudTenantSignature(reqWith({}), IDENTITY, { deploymentExposure: "public" }),
      ).toBe("invalid");
    });

    it("still accepts a correctly signed, fresh request", () => {
      process.env[KEY_ENV] = "secret-key";
      const ts = Math.floor(Date.now() / 1000);
      const req = reqWith({
        "x-paperclip-cloud-timestamp": String(ts),
        "x-paperclip-cloud-signature": sign("secret-key", ts),
      });
      expect(verifyCloudTenantSignature(req, IDENTITY, { deploymentExposure: "public" })).toBe(
        "valid",
      );
    });
  });
});
