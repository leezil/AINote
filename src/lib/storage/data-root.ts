import os from "node:os";
import path from "node:path";

/**
 * Writable directory for uploaded files + manifest.
 * - Vercel serverless: only /tmp is reliably writable → use it by default when VERCEL=1.
 * - Local dev: project `.data` folder.
 * - Override: DOCUMENT_STORE_ROOT=/absolute/path
 */
export function getDataStoreRoot(): string {
  const override = process.env.DOCUMENT_STORE_ROOT?.trim();
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  if (process.env.VERCEL === "1") {
    return path.join(os.tmpdir(), "ainote-data");
  }
  return path.join(process.cwd(), ".data");
}
