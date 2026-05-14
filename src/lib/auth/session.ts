/**
 * Authentication boundary (stub).
 * Today: no login. Later: return session + workspace mapping.
 */
export type AppSession = {
  userId: string;
  workspaceId: string;
};

export async function getOptionalSession(): Promise<AppSession | null> {
  return null;
}
