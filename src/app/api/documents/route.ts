import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { getPdfPageCount } from "@/lib/documents/pdf-text";
import { inferKindFromMime, normalizeMime } from "@/lib/documents/mime";
import {
  createDocumentStore,
  type StoredDocumentMeta,
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

    const filename = file.name || "upload";
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let mime = normalizeMime(filename, file.type);
    let kind = inferKindFromMime(mime);
    if (!kind && buffer.length >= 5) {
      const head = buffer.subarray(0, 5).toString("latin1");
      if (head.startsWith("%PDF-")) {
        mime = "application/pdf";
        kind = "pdf";
      }
    }
    if (!kind) {
      return NextResponse.json(
        { error: "지원하지 않는 형식입니다. (pdf, 이미지, txt)" },
        { status: 400 },
      );
    }

    const id = randomUUID();

    let pageCount = 1;
    if (kind === "pdf") {
      try {
        pageCount = await getPdfPageCount(buffer);
      } catch (err) {
        /** Vercel/네트워크 등으로 서버 파싱이 실패해도 업로드는 허용. 페이지 수는 클라이언트 뷰어에서 확정. */
        console.error("[ainote] getPdfPageCount failed (using placeholder):", err);
        pageCount = 1;
      }
    }

    const meta: StoredDocumentMeta = {
      id,
      filename,
      mime,
      kind,
      pageCount,
      bytes: buffer.byteLength,
      createdAt: new Date().toISOString(),
    };

    const store = createDocumentStore(workspaceId);
    await store.appendDocument(meta, buffer);

    return NextResponse.json({ document: meta });
  } catch (e) {
    const message = e instanceof Error ? e.message : "업로드에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
