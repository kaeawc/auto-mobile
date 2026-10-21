import type { ResourceContent, ResourceRegistry } from "../../src/server/resourceRegistry";

/** A template match as returned by `ResourceRegistry.matchTemplate`. */
export type TemplateMatch = NonNullable<ReturnType<typeof ResourceRegistry.matchTemplate>>;

/**
 * Reads a matched resource template through its plain `handler`. Templates that
 * need a read context (`handlerWithReadContext`) are a different registration
 * shape and must be read with that context, so they throw here.
 */
export function readTemplateMatch(match: TemplateMatch): Promise<ResourceContent> {
  const { template, params } = match;
  if ("handler" in template) {
    return template.handler(params);
  }
  throw new Error(`template ${template.uriTemplate} requires a read context`);
}
