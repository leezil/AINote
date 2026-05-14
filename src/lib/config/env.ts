/**
 * Centralized server-side configuration.
 * Keeps secrets and defaults in one place for future auth / multi-tenant wiring.
 */
export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

export function getGeminiModelId(): string {
  return process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
}

export function getDefaultWorkspaceId(): string {
  return process.env.DEFAULT_WORKSPACE_ID ?? "local";
}
