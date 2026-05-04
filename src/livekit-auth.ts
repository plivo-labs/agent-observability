import type { Context, Next } from "hono";
import { jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { basicAuthEnabled, config, liveKitAuthEnabled } from "./config.js";
import { buildErrorResponse } from "./response.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function basicAuthValid(header: string): boolean {
  if (!basicAuthEnabled || !header.startsWith("Basic ")) {
    return false;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }

  const splitAt = decoded.indexOf(":");
  if (splitAt < 0) {
    return false;
  }

  const username = decoded.slice(0, splitAt);
  const password = decoded.slice(splitAt + 1);
  return safeEqual(username, config.AGENT_OBSERVABILITY_USER!) &&
    safeEqual(password, config.AGENT_OBSERVABILITY_PASS!);
}

async function liveKitBearerValid(header: string): Promise<boolean> {
  if (!liveKitAuthEnabled || !header.startsWith("Bearer ")) {
    return false;
  }

  try {
    const token = header.slice("Bearer ".length);
    const secret = new TextEncoder().encode(config.LIVEKIT_API_SECRET!);
    const { payload } = await jwtVerify(token, secret, {
      issuer: config.LIVEKIT_API_KEY,
      algorithms: ["HS256"],
    });
    const observability = payload.observability;
    return typeof observability === "object" &&
      observability !== null &&
      (observability as { write?: unknown }).write === true;
  } catch {
    return false;
  }
}

export async function nativeLiveKitUploadAuth(c: Context, next: Next) {
  if (!basicAuthEnabled && !liveKitAuthEnabled) {
    await next();
    return;
  }

  const auth = c.req.header("authorization") ?? "";
  if (basicAuthValid(auth) || await liveKitBearerValid(auth)) {
    await next();
    return;
  }

  return c.json(
    buildErrorResponse("unauthorized", "Valid LiveKit observability Bearer token required"),
    401,
  );
}
