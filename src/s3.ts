import { S3Client } from "bun";
import { config, s3Enabled } from "./config.js";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET!,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    });
  }
  return client;
}

export async function uploadRecording(
  key: string,
  data: ArrayBuffer
): Promise<string> {
  if (!s3Enabled) {
    throw new Error("S3 is not configured");
  }

  const s3Key = `${config.S3_PREFIX}/${key}`;
  const s3 = getClient();

  await s3.write(s3Key, new Uint8Array(data), {
    type: "audio/ogg",
  });

  return s3.presign(s3Key, { expiresIn: 7 * 24 * 60 * 60 });
}
