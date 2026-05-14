import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createDocumentStore } from "@/lib/storage/document-store";
import { getWorkspaceContextFromRequestHeaders } from "@/lib/workspace/resolve-workspace";

export const runtime = "nodejs";

type Params = { documentId: string };

export async function GET(
  _req: Request,
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

  const buf = await store.readFileBytes(documentId);
  if (!buf) {
    return NextResponse.json({ error: "Missing file" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": meta.mime,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
