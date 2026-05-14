/**
 * Future: Cloudflare R2 (S3-compatible) adapter implementing the same operations
 * as {@link DocumentStore} (list/get/stream). Keep API routes thin and swap storage here.
 */
export type ObjectStorageConfig = {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};
