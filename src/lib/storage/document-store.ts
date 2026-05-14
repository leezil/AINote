import fs from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
import { getDataStoreRoot } from "@/lib/storage/data-root";
import {
  AI_SUCCESS_ASK_PURGE_EVERY,
  readAiAskCountFromParsedJson,
  sortDocumentsOldestFirst,
  totalBytesOfDocuments,
  WORKSPACE_STORAGE_CAP_BYTES,
} from "@/lib/storage/storage-policy";

export type StoredDocumentKind = "pdf" | "image" | "text";

export type StoredDocumentMeta = {
  id: string;
  filename: string;
  mime: string;
  kind: StoredDocumentKind;
  pageCount: number;
  bytes: number;
  createdAt: string;
  /** Vercel Blob public URL when using {@link BlobDocumentStore}. */
  blobUrl?: string;
};

type Manifest = {
  documents: StoredDocumentMeta[];
  aiAskCount?: number;
};

export { WORKSPACE_STORAGE_CAP_BYTES, AI_SUCCESS_ASK_PURGE_EVERY };

function sanitizeWorkspaceId(workspaceId: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe.length > 0 ? safe : "local";
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
    await this.writeManifest({ documents: [], aiAskCount: 0 });
  }

  /**
   * AI 질문이 성공했을 때 호출합니다.
   * 카운트가 `threshold` 이상이면 저장 문서를 모두 지우고 카운트를 0으로 리셋합니다.
   */
  async recordSuccessfulAiAsk(threshold: number = AI_SUCCESS_ASK_PURGE_EVERY): Promise<void> {
    await this.ensureReady();
    const manifest = await this.readManifest();
    const next = (manifest.aiAskCount ?? 0) + 1;
    if (next >= threshold) {
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
    return `ainote/ws_${sanitizeWorkspaceId(this.workspaceId)}`;
  }

  private manifestPathname(): string {
    return `${this.prefix()}/manifest.json`;
  }

  private filePathname(documentId: string): string {
    return `${this.prefix()}/files/${documentId}`;
  }

  private async readManifest(): Promise<Manifest> {
    const { blobs } = await list({
      prefix: `${this.prefix()}/`,
      limit: 1000,
      token: this.token(),
    });
    const man = blobs.find((b) => b.pathname === this.manifestPathname());
    if (!man) return { documents: [], aiAskCount: 0 };
    const res = await fetch(man.url, { cache: "no-store" });
    if (!res.ok) return { documents: [], aiAskCount: 0 };
    const parsed = (await res.json()) as unknown;
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
      access: "public",
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
    const res = await fetch(meta.blobUrl, { cache: "no-store" });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
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

  async appendDocument(meta: StoredDocumentMeta, data: Buffer): Promise<void> {
    const uploaded = await put(this.filePathname(meta.id), data, {
      access: "public",
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
    await this.writeManifest({ documents: [], aiAskCount: 0 });
  }

  async recordSuccessfulAiAsk(threshold: number = AI_SUCCESS_ASK_PURGE_EVERY): Promise<void> {
    const manifest = await this.readManifest();
    const next = (manifest.aiAskCount ?? 0) + 1;
    if (next >= threshold) {
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
