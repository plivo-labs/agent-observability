import { describe, test, expect } from "bun:test";
import * as jose from "jose";
import { verifyLivekitJwt } from "../src/auth.js";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret-that-is-long-enough";

async function signJwt(
  overrides: { iss?: string; secret?: string; exp?: number } = {}
): Promise<string> {
  const secret = new TextEncoder().encode(overrides.secret ?? API_SECRET);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(overrides.iss ?? API_KEY)
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(secret);
}

describe("verifyLivekitJwt", () => {
  test("returns error when auth header is missing", async () => {
    const result = await verifyLivekitJwt(undefined, API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing or invalid Authorization header");
  });

  test("returns error when auth header has no Bearer prefix", async () => {
    const result = await verifyLivekitJwt("Token abc", API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing or invalid Authorization header");
  });

  test("returns error for empty string", async () => {
    const result = await verifyLivekitJwt("", API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
  });

  test("verifies a valid JWT", async () => {
    const token = await signJwt();
    const result = await verifyLivekitJwt(`Bearer ${token}`, API_KEY, API_SECRET);
    expect(result.valid).toBe(true);
    expect(result.claims).toBeDefined();
    expect(result.claims!.iss).toBe(API_KEY);
  });

  test("rejects JWT with wrong secret", async () => {
    const token = await signJwt({ secret: "wrong-secret-that-is-long-enough" });
    const result = await verifyLivekitJwt(`Bearer ${token}`, API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JWT verification failed");
  });

  test("rejects JWT with wrong issuer", async () => {
    const token = await signJwt({ iss: "wrong-issuer" });
    const result = await verifyLivekitJwt(`Bearer ${token}`, API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JWT verification failed");
  });

  test("rejects expired JWT", async () => {
    const token = await signJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const result = await verifyLivekitJwt(`Bearer ${token}`, API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JWT verification failed");
  });

  test("rejects malformed token", async () => {
    const result = await verifyLivekitJwt("Bearer not-a-jwt", API_KEY, API_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JWT verification failed");
  });
});
