/**
 * Centralized server-side configuration.
 * Keeps secrets and defaults in one place for future auth / multi-tenant wiring.
 */
export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

/** Google AI Studio에서 1.5 일부 엔드포인트가 제거되어 404가 납니다. 구 설정도 동작하도록 치환합니다. */
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.5-flash-latest": "gemini-2.5-flash",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-pro-latest": "gemini-2.5-pro",
};

const GEMINI_MODEL_DEFAULT = "gemini-2.5-flash";

export function getGeminiModelId(): string {
  const raw = (process.env.GEMINI_MODEL ?? GEMINI_MODEL_DEFAULT).trim();
  const id = raw.length > 0 ? raw : GEMINI_MODEL_DEFAULT;
  return GEMINI_MODEL_ALIASES[id] ?? id;
}

export function getDefaultWorkspaceId(): string {
  return process.env.DEFAULT_WORKSPACE_ID ?? "local";
}
