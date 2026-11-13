import { z } from "zod/v4";

/** Factories keep individual schema uses independent. Depth matches the SDK walk budget. */
export const carPlayTemplateSchema = (depth = 0) => {
  const fields = {
    id: z.string(),
    type: z.string(),
    className: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    detailText: z.string().optional(),
    detail: z.string().optional(),
    header: z.string().optional(),
    message: z.string().optional(),
    enabled: z.boolean().optional(),
    hasImage: z.boolean().optional(),
    selected: z.boolean().optional(),
    titleVariants: z.array(z.string()).optional(),
  };
  return z
    .object({
      ...fields,
      sections: z.array(carPlayChildSchema(depth)).optional(),
      items: z.array(carPlayChildSchema(depth)).optional(),
      buttons: z.array(carPlayChildSchema(depth)).optional(),
      tabs: z.array(carPlayChildSchema(depth)).optional(),
      template: carPlayChildSchema(depth).optional(),
      actions: z.array(carPlayChildSchema(depth)).optional(),
      leadingNavigationBarButtons: z.array(carPlayChildSchema(depth)).optional(),
      trailingNavigationBarButtons: z.array(carPlayChildSchema(depth)).optional(),
      backButton: carPlayChildSchema(depth).optional(),
    })
    .passthrough();
};

// A lazy child avoids constructing an exponentially large schema tree.
const carPlayChildSchema = (depth: number): z.ZodType<CarPlayTemplateNode> =>
  z.lazy(() => (depth < 6 ? carPlayTemplateSchema(depth + 1) : z.never()));

export interface CarPlayTemplateNode {
  id: string;
  type: string;
  className?: string;
  title?: string;
  text?: string;
  detailText?: string;
  detail?: string;
  header?: string;
  message?: string;
  enabled?: boolean;
  hasImage?: boolean;
  selected?: boolean;
  titleVariants?: string[];
  sections?: CarPlayTemplateNode[];
  items?: CarPlayTemplateNode[];
  buttons?: CarPlayTemplateNode[];
  tabs?: CarPlayTemplateNode[];
  template?: CarPlayTemplateNode;
  actions?: CarPlayTemplateNode[];
  leadingNavigationBarButtons?: CarPlayTemplateNode[];
  trailingNavigationBarButtons?: CarPlayTemplateNode[];
  backButton?: CarPlayTemplateNode;
  [key: string]: unknown;
}

export const carPlayTemplateDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    connected: z.boolean(),
    templates: z.array(carPlayTemplateSchema()),
    presented: carPlayTemplateSchema().optional(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();

export type CarPlayTemplateDocument = z.infer<typeof carPlayTemplateDocumentSchema>;

export function parseCarPlayTemplateDocument(value: unknown): CarPlayTemplateDocument {
  return carPlayTemplateDocumentSchema.parse(value);
}

const carPlayActionSchema = z.enum(["select", "back", "popToRoot"]);

export const carPlayActionRequestSchema = z
  .object({
    id: z.string().optional(),
    action: carPlayActionSchema.default("select"),
  })
  .passthrough()
  .refine((request) => request.action !== "select" || Boolean(request.id?.trim()), {
    message: "select requires a nonempty id",
    path: ["id"],
  });

export type CarPlayActionRequest = z.input<typeof carPlayActionRequestSchema>;

export const carPlayActionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ok", "unsupported", "not_found", "failed"]),
    simulated: z.literal("sdk"),
    reason: z.string().optional(),
    id: z.string().optional(),
    action: carPlayActionSchema,
    templates: carPlayTemplateDocumentSchema,
  })
  .passthrough();

export type CarPlayActionResponse = z.infer<typeof carPlayActionResponseSchema>;

export function parseCarPlayActionResponse(value: unknown): CarPlayActionResponse {
  return carPlayActionResponseSchema.parse(value);
}
