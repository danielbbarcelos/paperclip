import { describe, expect, it } from "vitest";
import { assertAllowedUpstreamUrl } from "./cloud-upstreams.js";

// These cases never hit DNS: literal IPs are classified directly, and the
// localhost/127.0.0.1 dev escape hatch returns early.
describe("assertAllowedUpstreamUrl (SSRF guard)", () => {
  it("allows the localhost dev escape hatch", async () => {
    await expect(assertAllowedUpstreamUrl("http://localhost:3000/x")).resolves.toBeUndefined();
    await expect(assertAllowedUpstreamUrl("http://127.0.0.1:3000/x")).resolves.toBeUndefined();
  });

  it("rejects the cloud metadata endpoint", async () => {
    await expect(assertAllowedUpstreamUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /Refusing to connect/i,
    );
  });

  it("rejects private RFC1918 ranges", async () => {
    await expect(assertAllowedUpstreamUrl("https://10.0.0.5/x")).rejects.toThrow(/Refusing to connect/i);
    await expect(assertAllowedUpstreamUrl("https://192.168.1.1/x")).rejects.toThrow(/Refusing to connect/i);
    await expect(assertAllowedUpstreamUrl("https://172.16.0.1/x")).rejects.toThrow(/Refusing to connect/i);
  });

  it("rejects a malformed URL", async () => {
    await expect(assertAllowedUpstreamUrl("not a url")).rejects.toThrow(/Invalid cloud upstream URL/i);
  });
});
