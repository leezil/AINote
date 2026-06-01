import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { MAX_UPLOAD_FILE_BYTES } from "@/lib/documents/upload-limits";
import { blobFilePathname } from "@/lib/storage/workspace-id";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/*",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export async function POST(request: Request): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return NextResponse.json({ error: "Blob 스토어가 설정되지 않았습니다." }, { status: 503 });
  }

  const hdrs = await headers();
  const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);

  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const docId = pathname.split("/").pop() ?? "";
        const expected = blobFilePathname(workspaceId, docId);
        if (pathname !== expected) {
          throw new Error("허용되지 않은 업로드 경로입니다.");
        }
        if (!/^[0-9a-f-]{36}$/i.test(docId)) {
          throw new Error("문서 ID 형식이 올바르지 않습니다.");
        }

        return {
          maximumSizeInBytes: MAX_UPLOAD_FILE_BYTES,
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          addRandomSuffix: false,
          allowOverwrite: true,
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "업로드 토큰 발급에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
