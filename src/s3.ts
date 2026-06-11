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

/** Deterministic object key for a session's recording — shared by upload
 *  and delete so they can never drift. */
export function recordingObjectKey(filename: string): string {
  return `${config.S3_PREFIX}/${filename}`;
}

export async function uploadRecording(
  key: string,
  data: ArrayBuffer
): Promise<string> {
  if (!s3Enabled) {
    throw new Error("S3 is not configured");
  }

  const s3Key = recordingObjectKey(key);
  const s3 = getClient();

  await s3.write(s3Key, new Uint8Array(data), {
    type: "audio/ogg",
  });

  return s3.presign(s3Key, { expiresIn: 7 * 24 * 60 * 60 });
}

/** Best-effort delete of a recording object. No-ops when S3 is disabled.
 *  Used to clean up audio when its session is deleted so recordings don't
 *  outlive the session row. */
export async function deleteRecording(key: string): Promise<void> {
  if (!s3Enabled) {
    return;
  }
  await getClient().delete(recordingObjectKey(key));
}
