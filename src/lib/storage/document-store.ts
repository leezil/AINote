import fs from "node:fs/promises";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";
import { getDataStoreRoot } from "@/lib/storage/data-root";
import {
  getAiSuccessAskPurgeEvery,
  readAiAskCountFromParsedJson,
  sortDocumentsOldestFirst,
  totalBytesOfDocuments,
  WORKSPACE_STORAGE_CAP_BYTES,
} from "@/lib/storage/storage-policy";
import { blobWorkspacePrefix, sanitizeWorkspaceId } from "@/lib/storage/workspace-id";

export type StoredDocumentKind = "pdf" | "image" | "text";

export type StoredDocumentMeta = {
  id: string;
  filename: string;
  mime: string;
  kind: StoredDocumentKind;
  pageCount: number;
  bytes: number;
  createdAt: string;
  /** Vercel Blob URL when using {@link BlobDocumentStore} (public or private 스토어에 따라 다름). */
  blobUrl?: string;
};

type Manifest = {
  documents: StoredDocumentMeta[];
  aiAskCount?: number;
};

export { WORKSPACE_STORAGE_CAP_BYTES, getAiSuccessAskPurgeEvery };

/** 로컬 디스크·Vercel Blob 공통 필기 JSON 파일명 */
function inkStorageFilename(meta: StoredDocumentMeta, page?: number): string {
  if (meta.kind === "pdf") {
    const p =
      typeof page === "number" && Number.isFinite(page) && page >= 1
        ? Math.floor(page)
        : 1;
    return `p-${p}.json`;
  }
  return "default.json";
}

export class DocumentStore {
  constructor(private readonly workspaceId: string) {}

  private rootDir(): string {
    return path.join(getDataStoreRoot(), `ws_${sanitizeWorkspaceId(this.workspaceId)}`);
  }

  private manifestPath(): string {
    return path.join(this.rootDir(), "manifest.json");
  }

  private filesDir(): string {
    return path.join(this.rootDir(), "files");
  }

  private filePath(documentId: string): string {
    return path.join(this.filesDir(), documentId);
  }

  private inkDirForDocument(documentId: string): string {
    return path.join(this.rootDir(), "ink", documentId);
  }

  async readInk(documentId: string, page?: number): Promise<string | null> {
    await this.ensureReady();
    const meta = await this.getMeta(documentId);
    if (!meta) return null;
    const rel = inkStorageFilename(meta, page);
    const p = path.join(this.inkDirForDocument(documentId), rel);
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  async writeInk(
    documentId: string,
    page: number | undefined,
    utf8: string,
  ): Promise<void> {
    await this.ensureReady();
    const meta = await this.getMeta(documentId);
    if (!meta) {
      throw new Error("AINOTE_DOC_NOT_FOUND");
    }
    const dir = this.inkDirForDocument(documentId);
    await fs.mkdir(dir, { recursive: true });
    const rel = inkStorageFilename(meta, meta.kind === "pdf" ? page : undefined);
    await fs.writeFile(path.join(dir, rel), utf8, "utf8");
  }

  private async readManifest(): Promise<Manifest> {
    const raw = await fs.readFile(this.manifestPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const documents = (parsed as { documents?: StoredDocumentMeta[] }).documents ?? [];
    return {
      documents,
      aiAskCount: readAiAskCountFromParsedJson(parsed),
    };
  }

  private async writeManifest(m: Manifest): Promise<void> {
    const out: Manifest = {
      documents: m.documents,
      aiAskCount: m.aiAskCount ?? 0,
    };
    await fs.writeFile(this.manifestPath(), JSON.stringify(out, null, 2), "utf8");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.filesDir(), { recursive: true });
    try {
      await fs.access(this.manifestPath());
    } catch {
      const initial: Manifest = { documents: [], aiAskCount: 0 };
      await fs.writeFile(this.manifestPath(), JSON.stringify(initial, null, 2), "utf8");
    }
  }

  async list(): Promise<StoredDocumentMeta[]> {
    await this.ensureReady();
    const m = await this.readManifest();
    return m.documents;
  }

  async readFileBytes(documentId: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.filePath(documentId));
    } catch {
      return null;
    }
  }

  async getMeta(documentId: string): Promise<StoredDocumentMeta | null> {
    const docs = await this.list();
    return docs.find((d) => d.id === documentId) ?? null;
  }

  /**
   * 새 업로드 `incomingBytes`를 넣었을 때 합계가 `cap`을 넘지 않도록,
   * 가장 오래된 문서부터 삭제합니다.
   */
  async ensureRoomForUpload(
    incomingBytes: number,
    cap: number = WORKSPACE_STORAGE_CAP_BYTES,
  ): Promise<void> {
    if (incomingBytes > cap) {
      throw new Error("AINOTE_UPLOAD_EXCEEDS_CAP");
    }
    while (true) {
      const docs = await this.list();
      if (totalBytesOfDocuments(docs) + incomingBytes <= cap) return;
      if (docs.length === 0) {
        throw new Error("AINOTE_UPLOAD_EXCEEDS_CAP");
      }
      const oldest = sortDocumentsOldestFirst(docs)[0];
      await this.deleteDocument(oldest.id);
    }
  }

  async appendDocument(meta: StoredDocumentMeta, data: Buffer): Promise<void> {
    await this.ensureReady();
    await fs.writeFile(this.filePath(meta.id), data);
    const manifest = await this.readManifest();
    manifest.documents = [meta, ...manifest.documents.filter((d) => d.id !== meta.id)];
    await this.writeManifest(manifest);
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.ensureReady();
    try {
      await fs.unlink(this.filePath(documentId));
    } catch {
      // ignore
    }
    try {
      await fs.rm(this.inkDirForDocument(documentId), { recursive: true, force: true });
    } catch {
      // ignore
    }
    const manifest = await this.readManifest();
    manifest.documents = manifest.documents.filter((d) => d.id !== documentId);
    await this.writeManifest(manifest);
  }

  /** 모든 업로드 문서와 파일을 제거하고 AI 질문 카운트를 0으로 둡니다. */
  async purgeAllDocuments(): Promise<void> {
    await this.ensureReady();
    const manifest = await this.readManifest();
    for (const d of manifest.documents) {
      try {
        await fs.unlink(this.filePath(d.id));
      } catch {
        // ignore
      }
    }
    try {
      await fs.rm(path.join(this.rootDir(), "ink"), { recursive: true, force: true });
    } catch {
      // ignore
    }
    await this.writeManifest({ documents: [], aiAskCount: 0 });
  }

  /**
   * AI 질문이 성공했을 때 호출합니다.
   * 누적 성공 횟수가 `cap` 이상이면 저장 문서를 모두 지우고 카운트를 0으로 리셋합니다.
   * `getAiSuccessAskPurgeEvery()`가 null이면(환경 변수로 비활성) 아무 것도 하지 않습니다.
   */
  async recordSuccessfulAiAsk(threshold?: number | null): Promise<void> {
    const cap = threshold ?? getAiSuccessAskPurgeEvery();
    if (cap === null) return;

    await this.ensureReady();
    const manifest = await this.readManifest();
    const next = (manifest.aiAskCount ?? 0) + 1;
    if (next >= cap) {
      await this.purgeAllDocuments();
    } else {
      manifest.aiAskCount = next;
      await this.writeManifest(manifest);
    }
  }
}

/**
 * Vercel Blob 기반 저장소. 서버리스 인스턴스가 바뀌어도 동일 스토어를 읽습니다.
 * Vercel 프로젝트에 Blob 스토어를 만들고 `BLOB_READ_WRITE_TOKEN`을 넣으세요.
 */
export class BlobDocumentStore {
  constructor(private readonly workspaceId: string) {}

  private token(): string {
    const t = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!t) {
      throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
    }
    return t;
  }

  private prefix(): string {
    return blobWorkspacePrefix(this.workspaceId);
  }

  private manifestPathname(): string {
    return `${this.prefix()}/manifest.json`;
  }

  private filePathname(documentId: string): string {
    return `${this.prefix()}/files/${documentId}`;
  }

  private inkPathname(documentId: string, meta: StoredDocumentMeta, page?: number): string {
    return `${this.prefix()}/ink/${documentId}/${inkStorageFilename(meta, page)}`;
  }

  private async deleteAllBlobsWithPrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const res = await list({
        prefix,
        limit: 1000,
        token: this.token(),
        cursor,
      });
      for (const b of res.blobs) {
        try {
          await del(b.url, { token: this.token() });
        } catch {
          // ignore
        }
      }
      if (!res.hasMore) break;
      cursor = res.cursor;
      if (!cursor) break;
    }
  }

  async readInk(documentId: string, page?: number): Promise<string | null> {
    const meta = await this.getMeta(documentId);
    if (!meta) return null;
    const pathname = this.inkPathname(
      documentId,
      meta,
      meta.kind === "pdf" ? page : undefined,
    );
    const { blobs } = await list({
      prefix: pathname,
      limit: 10,
      token: this.token(),
    });
    const hit = blobs.find((b) => b.pathname === pathname);
    if (!hit) return null;
    const buf = await this.readBlobUrlBytes(hit.url);
    return buf?.toString("utf8") ?? null;
  }

  async writeInk(
    documentId: string,
    page: number | undefined,
    utf8: string,
  ): Promise<void> {
    const meta = await this.getMeta(documentId);
    if (!meta) {
      throw new Error("AINOTE_DOC_NOT_FOUND");
    }
    const pathname = this.inkPathname(
      documentId,
      meta,
      meta.kind === "pdf" ? page : undefined,
    );
    await put(pathname, utf8, {
      access: this.blobPutAccess(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
      token: this.token(),
    });
  }

  /**
   * Vercel Blob 스토어가 private이면 `put(..., { access: "public" })`가 거부됩니다.
   * public 전용 스토어는 환경 변수 `AINOTE_BLOB_ACCESS=public` 로 맞추세요.
   */
  private blobPutAccess(): "public" | "private" {
    const v = process.env.AINOTE_BLOB_ACCESS?.trim().toLowerCase();
    if (v === "public") return "public";
    return "private";
  }

  /** private Blob URL은 토큰이 있는 `get`으로만 읽을 수 있습니다. */
  private async readBlobUrlBytes(url: string): Promise<Buffer | null> {
    const isPrivateHost = url.includes(".private.blob.");
    if (isPrivateHost) {
      const g = await get(url, { access: "private", token: this.token() });
      if (!g || g.statusCode !== 200 || !g.stream) return null;
      return Buffer.from(await new Response(g.stream).arrayBuffer());
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  private async readManifest(): Promise<Manifest> {
    const { blobs } = await list({
      prefix: `${this.prefix()}/`,
      limit: 1000,
      token: this.token(),
    });
    const man = blobs.find((b) => b.pathname === this.manifestPathname());
    if (!man) return { documents: [], aiAskCount: 0 };
    const raw = await this.readBlobUrlBytes(man.url);
    if (!raw) return { documents: [], aiAskCount: 0 };
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    const documents = (parsed as { documents?: StoredDocumentMeta[] }).documents ?? [];
    return {
      documents,
      aiAskCount: readAiAskCountFromParsedJson(parsed),
    };
  }

  private async writeManifest(m: Manifest): Promise<void> {
    const out: Manifest = {
      documents: m.documents,
      aiAskCount: m.aiAskCount ?? 0,
    };
    await put(this.manifestPathname(), JSON.stringify(out), {
      access: this.blobPutAccess(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
      token: this.token(),
    });
  }

  async ensureReady(): Promise<void> {
    // no-op
  }

  async list(): Promise<StoredDocumentMeta[]> {
    const m = await this.readManifest();
    return m.documents;
  }

  async readFileBytes(documentId: string): Promise<Buffer | null> {
    const meta = await this.getMeta(documentId);
    if (!meta?.blobUrl) return null;
    return this.readBlobUrlBytes(meta.blobUrl);
  }

  async getMeta(documentId: string): Promise<StoredDocumentMeta | null> {
    const docs = await this.list();
    return docs.find((d) => d.id === documentId) ?? null;
  }

  async ensureRoomForUpload(
    incomingBytes: number,
    cap: number = WORKSPACE_STORAGE_CAP_BYTES,
  ): Promise<void> {
    if (incomingBytes > cap) {
      throw new Error("AINOTE_UPLOAD_EXCEEDS_CAP");
    }
    while (true) {
      const docs = await this.list();
      if (totalBytesOfDocuments(docs) + incomingBytes <= cap) return;
      if (docs.length === 0) {
        throw new Error("AINOTE_UPLOAD_EXCEEDS_CAP");
      }
      const oldest = sortDocumentsOldestFirst(docs)[0];
      await this.deleteDocument(oldest.id);
    }
  }

  /** private Blob URL 등 외부 blob 주소에서 바이트를 읽습니다. */
  async readBytesAtUrl(url: string): Promise<Buffer | null> {
    return this.readBlobUrlBytes(url);
  }

  /** 클라이언트가 Blob에 직접 올린 뒤 manifest만 등록합니다. */
  async registerClientBlobDocument(meta: StoredDocumentMeta): Promise<void> {
    if (!meta.blobUrl) {
      throw new Error("AINOTE_BLOB_URL_REQUIRED");
    }
    const manifest = await this.readManifest();
    manifest.documents = [meta, ...manifest.documents.filter((d) => d.id !== meta.id)];
    await this.writeManifest(manifest);
  }

  async appendDocument(meta: StoredDocumentMeta, data: Buffer): Promise<void> {
    const uploaded = await put(this.filePathname(meta.id), data, {
      access: this.blobPutAccess(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: meta.mime,
      token: this.token(),
      multipart: data.byteLength > 4_500_000,
    });
    const withUrl: StoredDocumentMeta = { ...meta, blobUrl: uploaded.url };
    const manifest = await this.readManifest();
    manifest.documents = [withUrl, ...manifest.documents.filter((d) => d.id !== meta.id)];
    await this.writeManifest(manifest);
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.deleteAllBlobsWithPrefix(`${this.prefix()}/ink/${documentId}/`);
    const meta = await this.getMeta(documentId);
    if (meta?.blobUrl) {
      try {
        await del(meta.blobUrl, { token: this.token() });
      } catch {
        // ignore
      }
    }
    const manifest = await this.readManifest();
    manifest.documents = manifest.documents.filter((d) => d.id !== documentId);
    await this.writeManifest(manifest);
  }

  async purgeAllDocuments(): Promise<void> {
    const manifest = await this.readManifest();
    for (const d of manifest.documents) {
      if (d.blobUrl) {
        try {
          await del(d.blobUrl, { token: this.token() });
        } catch {
          // ignore
        }
      }
    }
    await this.deleteAllBlobsWithPrefix(`${this.prefix()}/ink/`);
    await this.writeManifest({ documents: [], aiAskCount: 0 });
  }

  async recordSuccessfulAiAsk(threshold?: number | null): Promise<void> {
    const cap = threshold ?? getAiSuccessAskPurgeEvery();
    if (cap === null) return;

    const manifest = await this.readManifest();
    const next = (manifest.aiAskCount ?? 0) + 1;
    if (next >= cap) {
      await this.purgeAllDocuments();
    } else {
      manifest.aiAskCount = next;
      await this.writeManifest(manifest);
    }
  }
}

export function createDocumentStore(
  workspaceId: string,
): DocumentStore | BlobDocumentStore {
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return new BlobDocumentStore(workspaceId);
  }
  return new DocumentStore(workspaceId);
}
