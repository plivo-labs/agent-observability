import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(9090),

  // LiveKit JWT verification
  LIVEKIT_API_KEY: z.string().min(1, "LIVEKIT_API_KEY is required"),
  LIVEKIT_API_SECRET: z.string().min(1, "LIVEKIT_API_SECRET is required"),

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTO_MIGRATE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // S3 configuration (optional — when set, recordings are uploaded to S3)
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_PREFIX: z.string().default("recordings"),
});
