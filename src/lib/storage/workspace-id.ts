export function sanitizeWorkspaceId(workspaceId: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe.length > 0 ? safe : "local";
}

export function blobWorkspacePrefix(workspaceId: string): string {
  return `ainote/ws_${sanitizeWorkspaceId(workspaceId)}`;
}

export function blobFilePathname(workspaceId: string, documentId: string): string {
  return `${blobWorkspacePrefix(workspaceId)}/files/${documentId}`;
}
