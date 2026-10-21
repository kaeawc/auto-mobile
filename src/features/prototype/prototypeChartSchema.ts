import { z } from "zod";
import { keySchema, pointerSchema } from "./prototypeActionValues";
import { colorValueSchema } from "./prototypePresentationSchemas";

const chartSeriesSchema = z
  .object({
    path: pointerSchema,
    x: keySchema.optional(),
    y: keySchema,
    label: z.string(),
    color: colorValueSchema.optional(),
  })
  .strict();

/** The `chart` node's own fields (#14209); prototypeSpec.ts adds the common node shape. */
export const prototypeChartShape = {
  type: z.enum(["chart"]),
  variant: z.enum(["line", "area", "bar", "ring"]),
  series: z.array(chartSeriesSchema).min(1).max(4),
  yRange: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().optional(),
  xLabels: z.enum(["none", "ends", "all"]).optional(),
  goal: z.number().finite().optional(),
};
