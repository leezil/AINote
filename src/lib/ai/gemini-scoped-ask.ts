import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiApiKey, getGeminiModelId } from "@/lib/config/env";

const DEFAULT_MAX_TEXT_CHARS = 14_000;

function truncateWithMax(
  input: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, maxChars)}\n\n[truncated: original length ${input.length}]`,
    truncated: true,
  };
}

function stripDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl.trim());
  if (m) {
    return { mimeType: m[1], base64: m[2] ?? "" };
  }
  return { mimeType: "image/png", base64: dataUrl.trim() };
}

function normalizeInlineImage(input: { base64: string; mimeType: string }): {
  mimeType: string;
  data: string;
} {
  if (input.base64.trim().startsWith("data:")) {
    const cleaned = stripDataUrl(input.base64);
    return { mimeType: cleaned.mimeType, data: cleaned.base64 };
  }
  return { mimeType: input.mimeType, data: input.base64.trim() };
}

export type ScopedAskInput = {
  question: string;
  /** Human-readable scope description injected into system instruction. */
  scopeDescription: string;
  /** Optional text material strictly inside the scope. */
  scopeText?: string;
  /** Optional single image inside the scope (e.g. viewport capture or uploaded image). */
  scopeImage?: { base64: string; mimeType: string };
  /** Max characters for text truncation (full-document mode uses a larger value). */
  maxTextChars?: number;
};

export async function askGeminiScoped(input: ScopedAskInput): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (server environment).");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelId = getGeminiModelId();
  const maxText = input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  const textPayload = input.scopeText
    ? truncateWithMax(input.scopeText, maxText)
    : { text: "", truncated: false };

  const hasImage = !!input.scopeImage;
  const hasTextExtract = !!(input.scopeText && input.scopeText.trim().length > 0);

  const systemInstruction = [
    "You are a helpful lecture and study assistant.",
    "Answer in Korean unless the user explicitly writes in another language.",
    `Scope (follow strictly): ${input.scopeDescription}`,
    hasImage
      ? "The user message may include an image sent as inline image data. You MUST use that image: read visible text, diagrams, charts, handwriting, and layout. Never answer that you cannot view or process images when an image part is present."
      : "Use only the provided text materials for factual claims about the document.",
    hasTextExtract && hasImage
      ? "Both text extract and an image are provided: combine them when they refer to the same material."
      : "",
    !hasTextExtract && hasImage
      ? "No separate text extract is provided: answer using the image and the question alone."
      : "",
    "If the materials are genuinely insufficient, say so briefly and suggest what to add (e.g. another page capture). Do not invent unseen pages or citations.",
    "Be concise; use short bullets where appropriate.",
  ]
    .filter(Boolean)
    .join("\n");

  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction,
  });

  type Part =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };

  const userParts: Part[] = [];

  if (hasImage && !hasTextExtract) {
    userParts.push({
      text: `첨부 이미지를 반드시 확인한 뒤, 아래 질문에 답하세요.\n\n질문:\n${input.question}`,
    });
    userParts.push({
      inlineData: normalizeInlineImage(input.scopeImage!),
    });
  } else {
    userParts.push({
      text: [
        `질문:\n${input.question}`,
        "",
        hasImage ? "참고: 이어서 이미지(캡처 또는 첨부)가 한 장 더 제공됩니다." : "",
        hasTextExtract
          ? `범위 내 텍스트 자료:\n${textPayload.text}${
              textPayload.truncated ? "\n(일부 잘림)" : ""
            }`
          : "범위 내 텍스트 자료: (별도 텍스트 없음)",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    if (input.scopeImage) {
      userParts.push({
        inlineData: normalizeInlineImage(input.scopeImage),
      });
    }
  }

  const result = await model.generateContent({
    contents: [{ role: "user", parts: userParts }],
  });

  return result.response.text();
}
