import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { AskRequestSchema } from "@/lib/ai/ask-schema";
import { askGeminiScoped } from "@/lib/ai/gemini-scoped-ask";
import { extractPdfAllPagesText, extractPdfPageText } from "@/lib/documents/pdf-text";
import { createDocumentStore } from "@/lib/storage/document-store";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TEXT_FILE_CHARS = 20_000;
const MAX_PDF_FULL_TEXT_CHARS = 80_000;

function documentMissingMessage(): string {
  if (process.env.VERCEL === "1" && !process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return "문서를 서버에서 찾을 수 없습니다. Vercel은 요청마다 다른 인스턴스가 실행되어 /tmp 저장이 이어지지 않을 수 있습니다. Vercel Dashboard → Storage → Blob으로 스토어를 만든 뒤, 프로젝트 환경 변수에 BLOB_READ_WRITE_TOKEN을 넣고 문서를 다시 업로드해 주세요.";
  }
  return "문서를 찾을 수 없습니다. 새로고침 후 다시 업로드하거나 목록에서 문서를 다시 여세요.";
}

async function jsonAnswerWithAskAccounting(
  store: ReturnType<typeof createDocumentStore>,
  answer: string,
) {
  await store.recordSuccessfulAiAsk();
  return NextResponse.json({ answer });
}

export async function POST(req: Request) {
  const hdrs = await headers();
  const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = AskRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed.", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const body = parsed.data;
  const store = createDocumentStore(workspaceId);

  try {
    if (body.scope.kind === "pdf_page_text") {
      const meta = await store.getMeta(body.scope.documentId);
      if (!meta) {
        return NextResponse.json({ error: documentMissingMessage() }, { status: 404 });
      }
      if (meta.kind !== "pdf") {
        return NextResponse.json({ error: "해당 파일은 PDF가 아닙니다." }, { status: 400 });
      }
      const bytes = await store.readFileBytes(body.scope.documentId);
      if (!bytes) {
        return NextResponse.json({ error: "파일을 읽을 수 없습니다." }, { status: 404 });
      }
      const { text, pageCount } = await extractPdfPageText(bytes, body.scope.page);
      if (body.scope.page > pageCount) {
        return NextResponse.json({ error: "페이지 번호가 범위를 벗어났습니다." }, { status: 400 });
      }
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: `PDF "${meta.filename}"의 ${body.scope.page}/${pageCount} 페이지 텍스트 추출분`,
        scopeText: text.length > 0 ? text : "(이 페이지에서 추출된 텍스트가 비어 있습니다. 스캔 PDF일 수 있습니다.)",
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    if (body.scope.kind === "pdf_full_text") {
      const meta = await store.getMeta(body.scope.documentId);
      if (!meta) {
        return NextResponse.json({ error: documentMissingMessage() }, { status: 404 });
      }
      if (meta.kind !== "pdf") {
        return NextResponse.json({ error: "해당 파일은 PDF가 아닙니다." }, { status: 400 });
      }
      const bytes = await store.readFileBytes(body.scope.documentId);
      if (!bytes) {
        return NextResponse.json({ error: "파일을 읽을 수 없습니다." }, { status: 404 });
      }
      const { text, pageCount, truncated } = await extractPdfAllPagesText(bytes, {
        maxTotalChars: MAX_PDF_FULL_TEXT_CHARS,
        pageCountHint: body.scope.pageCountHint,
      });
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: `PDF "${meta.filename}" 전체 ${pageCount}페이지 텍스트(추출)${truncated ? " — 길이 제한으로 일부 잘림" : ""}`,
        scopeText: text,
        maxTextChars: MAX_PDF_FULL_TEXT_CHARS,
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    if (body.scope.kind === "pdf_page_text_plus_viewport") {
      const meta = await store.getMeta(body.scope.documentId);
      if (!meta) {
        return NextResponse.json({ error: documentMissingMessage() }, { status: 404 });
      }
      if (meta.kind !== "pdf") {
        return NextResponse.json({ error: "해당 파일은 PDF가 아닙니다." }, { status: 400 });
      }
      const bytes = await store.readFileBytes(body.scope.documentId);
      if (!bytes) {
        return NextResponse.json({ error: "파일을 읽을 수 없습니다." }, { status: 404 });
      }
      const { text, pageCount } = await extractPdfPageText(bytes, body.scope.page);
      if (body.scope.page > pageCount) {
        return NextResponse.json({ error: "페이지 번호가 범위를 벗어났습니다." }, { status: 400 });
      }
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: `PDF "${meta.filename}" ${body.scope.page}/${pageCount} 페이지 텍스트 + 사용자가 캡처한 동일 화면(필기/도형 포함 가능)`,
        scopeText: text.length > 0 ? text : "(이 페이지에서 추출된 텍스트가 비어 있습니다.)",
        scopeImage: {
          base64: body.scope.viewportImageBase64,
          mimeType: body.scope.viewportMimeType,
        },
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    if (body.scope.kind === "viewport_only") {
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: "사용자가 질문 시점에 캡처한 화면 이미지 한 장",
        scopeImage: {
          base64: body.scope.viewportImageBase64,
          mimeType: body.scope.viewportMimeType,
        },
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    if (body.scope.kind === "text_file") {
      const meta = await store.getMeta(body.scope.documentId);
      if (!meta) {
        return NextResponse.json({ error: documentMissingMessage() }, { status: 404 });
      }
      if (meta.kind !== "text") {
        return NextResponse.json({ error: "해당 파일은 텍스트 문서가 아닙니다." }, { status: 400 });
      }
      const bytes = await store.readFileBytes(body.scope.documentId);
      if (!bytes) {
        return NextResponse.json({ error: "파일을 읽을 수 없습니다." }, { status: 404 });
      }
      const full = bytes.toString("utf8");
      const clipped =
        full.length > MAX_TEXT_FILE_CHARS
          ? `${full.slice(0, MAX_TEXT_FILE_CHARS)}\n\n[truncated]`
          : full;
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: `텍스트 파일 "${meta.filename}" 전체(최대 ${MAX_TEXT_FILE_CHARS}자)`,
        scopeText: clipped,
        maxTextChars: MAX_TEXT_FILE_CHARS,
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    if (body.scope.kind === "image_file") {
      const meta = await store.getMeta(body.scope.documentId);
      if (!meta) {
        return NextResponse.json({ error: documentMissingMessage() }, { status: 404 });
      }
      if (meta.kind !== "image") {
        return NextResponse.json({ error: "해당 파일은 이미지가 아닙니다." }, { status: 400 });
      }
      const bytes = await store.readFileBytes(body.scope.documentId);
      if (!bytes) {
        return NextResponse.json({ error: "파일을 읽을 수 없습니다." }, { status: 404 });
      }
      const mime =
        meta.mime === "image/jpg" ? "image/jpeg" : meta.mime;
      const answer = await askGeminiScoped({
        question: body.question,
        scopeDescription: `업로드된 이미지 파일 "${meta.filename}" 한 장`,
        scopeImage: {
          base64: bytes.toString("base64"),
          mimeType: mime,
        },
      });
      return await jsonAnswerWithAskAccounting(store, answer);
    }

    return NextResponse.json({ error: "Unsupported scope." }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
