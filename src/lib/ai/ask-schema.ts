import { z } from "zod";

const imageMime = z.enum(["image/png", "image/jpeg", "image/webp"]);

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(8000),
  scope: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pdf_page_text"),
      documentId: z.string().min(1),
      page: z.number().int().min(1),
    }),
    z.object({
      kind: z.literal("pdf_full_text"),
      documentId: z.string().min(1),
      pageCountHint: z.number().int().min(1).max(5000).optional(),
    }),
    z.object({
      kind: z.literal("pdf_page_text_plus_viewport"),
      documentId: z.string().min(1),
      page: z.number().int().min(1),
      viewportImageBase64: z.string().min(10),
      viewportMimeType: imageMime,
    }),
    z.object({
      kind: z.literal("viewport_only"),
      viewportImageBase64: z.string().min(10),
      viewportMimeType: imageMime,
    }),
    z.object({
      kind: z.literal("text_file"),
      documentId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("image_file"),
      documentId: z.string().min(1),
    }),
  ]),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;
