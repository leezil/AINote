import fs from "node:fs/promises";
import path from "node:path";
import { getDataStoreRoot } from "@/lib/storage/data-root";

export type StoredDocumentKind = "pdf" | "image" | "text";

export type StoredDocumentMeta = {
  id: string;
  filename: string;
  mime: string;
  kind: StoredDocumentKind;
  pageCount: number;
  bytes: number;
  createdAt: string;
};

type Manifest = {
  documents: StoredDocumentMeta[];
};

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

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.filesDir(), { recursive: true });
    try {
      await fs.access(this.manifestPath());
    } catch {
      const initial: Manifest = { documents: [] };
      await fs.writeFile(this.manifestPath(), JSON.stringify(initial, null, 2), "utf8");
    }
  }

  async list(): Promise<StoredDocumentMeta[]> {
    await this.ensureReady();
    const raw = await fs.readFile(this.manifestPath(), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    return parsed.documents ?? [];
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

  async appendDocument(meta: StoredDocumentMeta, data: Buffer): Promise<void> {
    await this.ensureReady();
    await fs.writeFile(this.filePath(meta.id), data);
    const manifest: Manifest = JSON.parse(
      await fs.readFile(this.manifestPath(), "utf8"),
    ) as Manifest;
    manifest.documents = [meta, ...manifest.documents.filter((d) => d.id !== meta.id)];
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2), "utf8");
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.ensureReady();
    try {
      await fs.unlink(this.filePath(documentId));
    } catch {
      // ignore
    }
    const manifest: Manifest = JSON.parse(
      await fs.readFile(this.manifestPath(), "utf8"),
    ) as Manifest;
    manifest.documents = manifest.documents.filter((d) => d.id !== documentId);
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2), "utf8");
  }
}

export function createDocumentStore(workspaceId: string): DocumentStore {
  return new DocumentStore(workspaceId);
}
