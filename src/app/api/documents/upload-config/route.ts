import { NextResponse } from "next/server";
import { MAX_UPLOAD_FILE_BYTES, DIRECT_UPLOAD_SAFE_BYTES } from "@/lib/documents/upload-limits";

export const runtime = "nodejs";

function blobPutAccess(): "public" | "private" {
  const v = process.env.AINOTE_BLOB_ACCESS?.trim().toLowerCase();
  if (v === "public") return "public";
  return "private";
}

export async function GET() {
  const blobConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
  return NextResponse.json({
    maxFileBytes: MAX_UPLOAD_FILE_BYTES,
    directUploadMaxBytes: DIRECT_UPLOAD_SAFE_BYTES,
    useClientBlobUpload: blobConfigured,
    blobAccess: blobPutAccess(),
  });
}
