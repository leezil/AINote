import { getDefaultWorkspaceId } from "@/lib/config/env";

export type WorkspaceContext = {
  /** Stable id for storage partitioning (solo: env default; later: user/org). */
  workspaceId: string;
};

/**
 * Resolves workspace from headers first, then env default.
 * Future: validate session and map user -> workspaceId.
 */
export function getWorkspaceContextFromRequestHeaders(headers: {
  get(name: string): string | null;
}): WorkspaceContext {
  const headerId = headers.get("x-workspace-id")?.trim();
  return {
    workspaceId: headerId && headerId.length > 0 ? headerId : getDefaultWorkspaceId(),
  };
}
