import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  assertUploadSize,
  buildDocumentMetaFromBuffer,
  UploadValidationError,
} from "@/lib/documents/process-upload";
import {
  createDocumentStore,
  WORKSPACE_STORAGE_CAP_BYTES,
} from "@/lib/storage/document-store";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";

export async function GET() {
  try {
    const hdrs = await headers();
    const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);
    const store = createDocumentStore(workspaceId);
    const documents = await store.list();
    return NextResponse.json({ documents });
  } catch (e) {
    const message = e instanceof Error ? e.message : "문서 목록을 불러올 수 없습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const hdrs = await headers();
    const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);
    const store = createDocumentStore(workspaceId);
    await store.ensureReady();

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart/form-data 로 파일을 업로드하세요." },
        { status: 415 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file 필드가 필요합니다." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    assertUploadSize(buffer.byteLength);

    const meta = await buildDocumentMetaFromBuffer(buffer, file.name || "upload", file.type);

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

    await store.appendDocument(meta, buffer);
    return NextResponse.json({ document: meta });
  } catch (e) {
    if (e instanceof UploadValidationError) {
      const status = e.code === "TOO_LARGE" ? 413 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    const message = e instanceof Error ? e.message : "업로드에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
