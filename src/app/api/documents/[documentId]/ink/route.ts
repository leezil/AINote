import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { inkPayloadSchema } from "@/lib/ink/stroke-json";
import { createDocumentStore } from "@/lib/storage/document-store";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";

type Params = { documentId: string };

function parsePageParam(sp: URLSearchParams): number | undefined {
  const raw = sp.get("page");
  if (raw == null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
) {
  const { documentId } = await ctx.params;
  const hdrs = await headers();
  const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);
  const store = createDocumentStore(workspaceId);
  const meta = await store.getMeta(documentId);
  if (!meta) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const page = parsePageParam(new URL(req.url).searchParams);
  const raw = await store.readInk(documentId, meta.kind === "pdf" ? page : undefined);
  if (!raw) {
    return NextResponse.json({ strokes: [] }, { status: 200 });
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return NextResponse.json(
      { strokes: Array.isArray(parsed) ? parsed : [] },
      { status: 200 },
    );
  } catch {
    return NextResponse.json({ strokes: [] }, { status: 200 });
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<Params> },
) {
  const { documentId } = await ctx.params;
  const hdrs = await headers();
  const { workspaceId } = getWorkspaceContextFromRequestHeaders(hdrs);
  const store = createDocumentStore(workspaceId);
  const meta = await store.getMeta(documentId);
  if (!meta) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = inkPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid strokes payload" }, { status: 400 });
  }

  const { strokes, page: bodyPage } = parsed.data;
  if (meta.kind === "pdf") {
    const page =
      typeof bodyPage === "number" && Number.isFinite(bodyPage) && bodyPage >= 1
        ? Math.floor(bodyPage)
        : 1;
    await store.writeInk(documentId, page, JSON.stringify(strokes));
  } else {
    await store.writeInk(documentId, undefined, JSON.stringify(strokes));
  }

  return NextResponse.json({ ok: true });
}
