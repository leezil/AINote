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

/** 교재·문제 풀이 답변이 한 덩어리로 나오지 않도록 출력 뼈대를 강제한다. */
const OUTPUT_FORMAT_KO = [
  "출력 형식: 사용자가 **문제 풀이·해설·연습 정답·교재 구절 설명** 등을 요청하면 아래 규칙을 **반드시** 지켜라. (인사, 잡담 등 일반 대화는 짧게 답하고 이 형식은 쓰지 않아도 된다.)",
  "1) 교재에 적힌 **번호·절 순서**(예: 1A, 1B, 2A, Grammar 3B)를 위에서 아래로 **원본과 같은 순서**로 맞춘다.",
  "2) 각 소항목마다 **같은 패턴**을 반복한다. 긴 문단으로 뭉치지 말고, 항목 사이에 **빈 줄**을 넣는다.",
  "3) 각 블록은 반드시 다음 네 줄 구조를 쓴다(라벨은 그대로):",
  '   첫 줄: "---" (구분선)',
  '   둘째 줄: "[원문]" + 공백 + 교재에서 인용한 문장·문항·지시문(짧게. 영어는 그대로 적어도 된다)',
  '   셋째 줄: "[설명·해석]" + 공백 + 풀이·뜻·정답·이유(한국어로, 여기에만 상세히)',
  "   넷째 줄: 빈 줄",
  "4) 원문이 짧은 단어·구만 있어도 [원문] 줄에 적고, 풀이는 [설명·해석]에만 적는다. 두 줄을 한 줄에 합치지 마라.",
  "5) 이미지가 있으면 화면에 보이는 **줄·블록 순서**를 따라 위에서 아래로 맞춘다(위쪽 문제부터).",
  "6) 서론 한두 문장은 허용하되, 본문은 위 형식 위주로 쓴다.",
].join("\n");

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
    OUTPUT_FORMAT_KO,
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
      text: `첨부 이미지를 반드시 확인한 뒤, 아래 질문에 답하세요. 답변은 [원문] / [설명·해석] 줄 형식을 지켜 주세요.\n\n질문:\n${input.question}`,
    });
    userParts.push({
      inlineData: normalizeInlineImage(input.scopeImage!),
    });
  } else {
    userParts.push({
      text: [
        `질문:\n${input.question}`,
        "",
        "답변은 시스템 지시의 [원문] / [설명·해석] 줄 형식을 지켜 주세요.",
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
