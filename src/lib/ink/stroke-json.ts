import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });

export const inkStrokeSchema = z.object({
  color: z.string(),
  width: z.number(),
  points: z.array(pointSchema),
});

export const inkPayloadSchema = z.object({
  strokes: z.array(inkStrokeSchema),
  page: z.number().int().min(1).optional(),
});

export type InkStrokeJson = z.infer<typeof inkStrokeSchema>;
