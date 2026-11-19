import { z } from "zod/v3";
import { keySchema } from "./prototypeActionValues";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeMapSchema } from "./prototypeMapSchema";

/**
 * The `webView` node schema (#14312): an https page limited to 1-8 exact origins, with typed
 * navigation state keys and navigation action lists. There is no inline `html` field and no script
 * field: a spec carries no markup or code. Rules the contract cannot express live in
 * `prototypeWebView.ts`.
 */
export function prototypeWebViewSchema<T extends z.ZodRawShape, A extends z.ZodTypeAny>(
  common: T,
  actionList: A,
) {
  return z
    .object({
      ...common,
      type: z.enum(["webView"]),
      // A `webview.*` call names this node through a `kind: "key"` argument, so the id is a state key.
      id: keySchema.optional(),
      url: z.string().max(2048).regex(prototypeContractPatterns.webViewUrl),
      allowedOrigins: z
        .array(z.string().max(256).regex(prototypeContractPatterns.webOrigin))
        .min(1)
        .max(8)
        .refine((origins) => new Set(origins).size === origins.length),
      javaScript: z.boolean().optional(),
      navigationStateKey: keySchema.optional(),
      titleKey: keySchema.optional(),
      canGoBackKey: keySchema.optional(),
      onNavigate: actionList.optional(),
      onBlockedNavigation: actionList.optional(),
    })
    .strict();
}

/** The nodes that draw a platform surface (`map`, `webView`), built from the shared node fields. */
export function prototypeSurfaceNodeSchemas<T extends z.ZodRawShape, A extends z.ZodTypeAny>(
  common: T,
  actionList: A,
) {
  return [
    prototypeMapSchema(common, actionList),
    prototypeWebViewSchema(common, actionList),
  ] as const;
}
