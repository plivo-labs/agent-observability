/**
 * SSRF guard unit tests. Hermetic: IP-literal + scheme paths run directly; the
 * hostname resolve→block path is exercised by injecting a fake resolver (no
 * network), so the core "a name that maps to a private IP is blocked" logic is
 * covered rather than skipped.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { assertPublicUrl, SsrfError, __setResolverForTest } from "../src/net/public-url.js";
import { config } from "../src/config.js";

describe("assertPublicUrl", () => {
  test("allows a public IP literal", async () => {
    await expect(assertPublicUrl("http://8.8.8.8/hook")).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://1.1.1.1/x")).resolves.toBeUndefined();
  });

  test("rejects loopback / private / link-local / metadata IPv4", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://10.0.0.5/x",
      "http://172.16.9.9/x",
      "http://192.168.1.1/x",
      "http://0.0.0.0/x",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  test("rejects IPv6 loopback / unique-local / mapped-private", async () => {
    for (const url of ["http://[::1]/x", "http://[fd00::1]/x", "http://[::ffff:127.0.0.1]/x"]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  test("rejects the full IPv6 link-local /10, site-local /10, and NAT64-embedded private v4", async () => {
    for (const url of [
      "http://[fe80::1]/x", // link-local, canonical prefix
      "http://[fe90::1]/x", // link-local /10 — beyond the literal fe80 string prefix
      "http://[febf::1]/x", // link-local /10 upper edge
      "http://[fec0::1]/x", // site-local /10 (deprecated, internally routable)
      "http://[64:ff9b::a9fe:a9fe]/x", // NAT64 re-encoding of 169.254.169.254 (metadata)
      "http://[64:ff9b::10.0.0.5]/x", // NAT64, dotted tail form
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  test("allows a public NAT64-embedded v4 and plain public IPv6", async () => {
    await expect(assertPublicUrl("http://[64:ff9b::808:808]/x")).resolves.toBeUndefined(); // 8.8.8.8
    await expect(assertPublicUrl("http://[2606:4700::1111]/x")).resolves.toBeUndefined();
  });

  test("rejects non-http(s) schemes", async () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://x"]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  test("rejects a malformed URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("assertPublicUrl — hostname resolve→block (injected resolver)", () => {
  afterEach(() => {
    // Each test installs its own restore; belt-and-suspenders reset to default.
    __setResolverForTest(async () => ["93.184.216.34"]);
  });

  test("blocks a hostname that resolves to a private address", async () => {
    const restore = __setResolverForTest(async () => ["10.1.2.3"]);
    try {
      await expect(assertPublicUrl("https://evil.example.com/hook")).rejects.toBeInstanceOf(SsrfError);
    } finally {
      restore();
    }
  });

  test("blocks when ANY resolved address is private (mixed A records)", async () => {
    const restore = __setResolverForTest(async () => ["93.184.216.34", "169.254.169.254"]);
    try {
      await expect(assertPublicUrl("https://dual.example.com/x")).rejects.toBeInstanceOf(SsrfError);
    } finally {
      restore();
    }
  });

  test("allows a hostname that resolves only to public addresses", async () => {
    const restore = __setResolverForTest(async () => ["93.184.216.34"]);
    try {
      await expect(assertPublicUrl("https://good.example.com/hook")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("rejects when resolution fails", async () => {
    const restore = __setResolverForTest(async () => {
      throw new Error("ENOTFOUND");
    });
    try {
      await expect(assertPublicUrl("https://nxdomain.example.com/x")).rejects.toBeInstanceOf(SsrfError);
    } finally {
      restore();
    }
  });
});

describe("assertPublicUrl — WEBHOOK_URL_ALLOWLIST opt-in", () => {
  const prior = config.WEBHOOK_URL_ALLOWLIST;
  afterEach(() => {
    config.WEBHOOK_URL_ALLOWLIST = prior;
    __setResolverForTest(async () => ["93.184.216.34"]);
  });

  test("an allowlisted exact hostname skips the public-address requirement", async () => {
    config.WEBHOOK_URL_ALLOWLIST = "hooks.internal.corp";
    const restore = __setResolverForTest(async () => ["10.1.2.3"]);
    try {
      await expect(assertPublicUrl("https://hooks.internal.corp/alert")).resolves.toBeUndefined();
      // A NON-listed host resolving private is still blocked.
      await expect(assertPublicUrl("https://other.internal.corp/alert")).rejects.toBeInstanceOf(SsrfError);
    } finally {
      restore();
    }
  });

  test("an allowlisted CIDR admits matching IPs only", async () => {
    config.WEBHOOK_URL_ALLOWLIST = "10.1.0.0/16";
    await expect(assertPublicUrl("http://10.1.2.3/x")).resolves.toBeUndefined();
    await expect(assertPublicUrl("http://10.2.0.1/x")).rejects.toBeInstanceOf(SsrfError);
  });

  test("an allowlisted IP literal admits exactly that IP", async () => {
    config.WEBHOOK_URL_ALLOWLIST = "192.168.7.7";
    await expect(assertPublicUrl("http://192.168.7.7/x")).resolves.toBeUndefined();
    await expect(assertPublicUrl("http://192.168.7.8/x")).rejects.toBeInstanceOf(SsrfError);
  });

  test("empty allowlist (default) keeps the strict guard", async () => {
    config.WEBHOOK_URL_ALLOWLIST = undefined;
    await expect(assertPublicUrl("http://10.1.2.3/x")).rejects.toBeInstanceOf(SsrfError);
  });
});
