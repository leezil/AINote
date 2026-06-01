import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  assertUploadSize,
  buildDocumentMetaFromBuffer,
  UploadValidationError,
} from "@/lib/documents/process-upload";
import {
  BlobDocumentStore,
  createDocumentStore,
  WORKSPACE_STORAGE_CAP_BYTES,
} from "@/lib/storage/document-store";
import { blobFilePathname } from "@/lib/storage/workspace-id";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
      return NextResponse.json(
        { error: "대용량 업로드는 Blob 스토어 설정이 필요합니다." },
        { status: 503 },
      );
    }

    const hdrs = await headers();
    const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);
    const store = createDocumentStore(workspaceId);
    if (!(store instanceof BlobDocumentStore)) {
      return NextResponse.json({ error: "Blob 스토어를 사용할 수 없습니다." }, { status: 503 });
    }

    const body = (await req.json()) as {
      documentId?: string;
      filename?: string;
      blobUrl?: string;
      bytes?: number;
      mime?: string;
    };

    const documentId = body.documentId?.trim();
    const filename = body.filename?.trim();
    const blobUrl = body.blobUrl?.trim();
    const bytes = body.bytes;
    if (!documentId || !filename || !blobUrl || typeof bytes !== "number") {
      return NextResponse.json(
        { error: "documentId, filename, blobUrl, bytes 가 필요합니다." },
        { status: 400 },
      );
    }

    assertUploadSize(bytes);

    const expectedPath = blobFilePathname(workspaceId, documentId);
    if (!blobUrl.includes(expectedPath)) {
      return NextResponse.json({ error: "업로드 경로가 올바르지 않습니다." }, { status: 400 });
    }

    const buffer = await store.readBytesAtUrl(blobUrl);
    if (!buffer) {
      return NextResponse.json({ error: "업로드된 파일을 읽을 수 없습니다." }, { status: 400 });
    }
    if (buffer.byteLength !== bytes) {
      return NextResponse.json({ error: "파일 크기가 일치하지 않습니다." }, { status: 400 });
    }

    const meta = await buildDocumentMetaFromBuffer(buffer, filename, body.mime, documentId);

    try {
      await store.ensureRoomForUpload(meta.bytes, WORKSPACE_STORAGE_CAP_BYTES);
    } catch (e) {
      if (e instanceof Error && e.message === "AINOTE_UPLOAD_EXCEEDS_CAP") {
        return NextResponse.json(
          {
            error:
              "저장 용량 1GB 한도를 초과합니다. 기존 문서를 지워도 새 파일이 너무 크거나, 비울 수 없습니다.",
          },
          { status: 413 },
        );
      }
      throw e;
    }

    const withUrl = { ...meta, blobUrl };
    await store.registerClientBlobDocument(withUrl);
    return NextResponse.json({ document: withUrl });
  } catch (e) {
    if (e instanceof UploadValidationError) {
      const status = e.code === "TOO_LARGE" ? 413 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    const message = e instanceof Error ? e.message : "업로드 등록에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
