import type { ResourceContent, ResourceReadContext } from "../../src/server/resourceRegistry";

/** A matched resource template, as `ResourceRegistry.matchTemplate` returns it. */
interface MatchedTemplate {
  template:
    | { handler: (params: Record<string, string>) => Promise<ResourceContent> }
    | {
        handlerWithReadContext: (
          params: Record<string, string>,
          context: ResourceReadContext,
        ) => Promise<ResourceContent>;
      };
  params: Record<string, string>;
}

/** Run a matched template's handler whichever form it registered, with an anonymous reader. */
export function invokeResourceTemplate(
  match: MatchedTemplate,
  context: ResourceReadContext = {},
): Promise<ResourceContent> {
  const { template, params } = match;
  return "handlerWithReadContext" in template
    ? template.handlerWithReadContext(params, context)
    : template.handler(params);
}
