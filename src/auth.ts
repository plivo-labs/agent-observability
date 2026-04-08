import * as jose from "jose";

export async function verifyLivekitJwt(
  authHeader: string | undefined,
  apiKey: string,
  apiSecret: string
): Promise<{ valid: boolean; claims?: jose.JWTPayload; error?: string }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false, error: "Missing or invalid Authorization header" };
  }

  const token = authHeader.slice(7);

  try {
    const secret = new TextEncoder().encode(apiSecret);
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: apiKey,
      clockTolerance: 10,
    });
    return { valid: true, claims: payload };
  } catch (e) {
    return {
      valid: false,
      error: `JWT verification failed: ${(e as Error).message}`,
    };
  }
}
