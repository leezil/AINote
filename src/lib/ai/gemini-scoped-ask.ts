import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiApiKey, getGeminiModelId } from "@/lib/config/env";

const MAX_TEXT_CHARS = 14_000;

function truncateText(input: string): { text: string; truncated: boolean } {
  if (input.length <= MAX_TEXT_CHARS) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: original length ${input.length}]`,
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
  /** Optional single image inside the scope (e.g. viewport capture). */
  scopeImage?: { base64: string; mimeType: string };
};

export async function askGeminiScoped(input: ScopedAskInput): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (server environment).");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelId = getGeminiModelId();

  const systemInstruction = [
    "You are a lecture note assistant.",
    "Answer in Korean unless the user explicitly writes in another language.",
    "You MUST only rely on the user-provided scope materials included in this request (text and/or a single image).",
    "If the scope materials do not contain enough information, say so clearly and ask what narrower scope to capture (do not invent facts).",
    "Do not reference other pages, other files, or prior chat turns (there is no hidden context).",
    `Declared scope: ${input.scopeDescription}`,
    "Be concise. Prefer short bullets for explanations.",
  ].join("\n");

  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction,
  });

  const textPayload = input.scopeText
    ? truncateText(input.scopeText)
    : { text: "", truncated: false };

  const userParts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [
    {
      text: [
        `질문:\n${input.question}`,
        "",
        input.scopeText
          ? `범위 내 텍스트 자료:\n${textPayload.text}${
              textPayload.truncated ? "\n(일부 잘림)" : ""
            }`
          : "범위 내 텍스트 자료: (없음)",
      ].join("\n"),
    },
  ];

  if (input.scopeImage) {
    const inline = normalizeInlineImage(input.scopeImage);
    userParts.push({
      inlineData: {
        mimeType: inline.mimeType,
        data: inline.data,
      },
    });
  }

  const result = await model.generateContent({
    contents: [{ role: "user", parts: userParts }],
  });

  return result.response.text();
}
