/**
 * Centralized server-side configuration.
 * Keeps secrets and defaults in one place for future auth / multi-tenant wiring.
 */
export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

/**
 * `GEMINI_MODEL` — AI Studio 쿼터 표 기준 참고(실제 한도는 계정·정책에 따라 변동).
 *
 * - **일 RPD가 가장 큰 쪽(표 기준 1.5K/일, RPM 15)**: Gemma 4 26B / Gemma 4 31B. `generateContent`·이미지 입력 가능 여부는 모델 카드 확인.
 * - **Gemini 중 균형(기본값)**: `gemini-3.1-flash-lite` — RPD **500**, RPM **15**, PDF·이미지 질문에 맞춤.
 * - Live API·TTS·Imagen·Veo 등은 이 앱의 일반 채팅 API와 용도·한도 체계가 다름.
 *
 * `…flash`(비 Lite)는 RPD가 작은 경우가 많아 Lite로 별칭 처리합니다.
 */
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-1.5-flash": "gemini-3.1-flash-lite",
  "gemini-1.5-flash-latest": "gemini-3.1-flash-lite",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-pro-latest": "gemini-2.5-pro",
  /** Lite가 아닌 3.1 Flash는 무료 티어에서 일일 한도가 작은 경우가 많아, 호환되는 Lite로 통일 */
  "gemini-3.1-flash": "gemini-3.1-flash-lite",
  "gemini-3.1-flash-latest": "gemini-3.1-flash-lite",
};

/**
 * 기본: `gemini-3.1-flash-lite` — Gemini 계열 중 표 기준 **RPD 500·RPM 15**로 넉넉하고, PDF·이미지에 적합.
 * **일 한도만 최대**로 쓰려면 `GEMINI_MODEL`에 AI Studio에 표시된 **Gemma 4** 모델 ID를 넣으면 됨(표 기준 RPD 1.5K).
 */
const GEMINI_MODEL_DEFAULT = "gemini-3.1-flash-lite";

export function getGeminiModelId(): string {
  const raw = (process.env.GEMINI_MODEL ?? GEMINI_MODEL_DEFAULT).trim();
  const id = raw.length > 0 ? raw : GEMINI_MODEL_DEFAULT;
  return GEMINI_MODEL_ALIASES[id] ?? id;
}

export function getDefaultWorkspaceId(): string {
  return process.env.DEFAULT_WORKSPACE_ID ?? "local";
}
