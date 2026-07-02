/**
 * SSRF guard unit tests. Hermetic: only IP-literal + scheme paths are asserted
 * (hostname DNS resolution is skipped under NODE_ENV=test, so no network here).
 */
import { describe, test, expect } from "bun:test";
import { assertPublicUrl, SsrfError } from "../src/net/public-url.js";

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

  test("rejects non-http(s) schemes", async () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://x"]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
    }
  });

  test("rejects a malformed URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });
});
