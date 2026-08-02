/**
 * Utility functions for tool handlers
 */
import { OPERATION_CANCELLED_MESSAGE } from "./constants";
import { serverConfig } from "./ServerConfig";

const stripAccessibilityExtras = (key: string, value: unknown): unknown => {
  if (key === "extras") {
    return undefined;
  }
  return value;
};

export const stringifyToolResponse = (content: unknown): string => {
  // Pretty-printing (indent=2) is ~35% of the serialized size on element-heavy
  // observations and carries no meaning for the model — drop it when the compact
  // flag is set. Same data, fewer tokens; no effect on tapOn/text matching.
  const indent = serverConfig.isToolResultsCompactJsonEnabled() ? undefined : 2;
  return JSON.stringify(content, stripAccessibilityExtras, indent);
};

/**
 * Interface for tool response formatter
 */
export interface ToolResponseFormatter {
  createJSONToolResponse(content: any): {
    content: Array<{
      type: "text";
      text: string;
    }>;
  };
  createImageToolResponse(base64Data: string, mimeType: string): {
    content: Array<{
      type: "image";
      data: string;
      mimeType: string;
    }>;
  };
}

/**
 * Default tool response formatting implementation
 */
export class DefaultToolResponseFormatter implements ToolResponseFormatter {
  /**
   * Creates a standardized tool response with text content
   * @param content Any data that will be stringified as JSON
   * @returns A properly formatted tool response object
   */
  createJSONToolResponse(content: any): {
    content: Array<{
      type: "text";
      text: string;
    }>;
  } {
    return {
      content: [
        {
          type: "text",
          text: stringifyToolResponse(content)
        }
      ]
    };
  }

  /**
   * Creates a standardized tool response with image content
   * @param base64Data Base64 encoded image data
   * @param mimeType The MIME type of the image (e.g., "image/png", "image/webp")
   * @returns A properly formatted tool response object
   */
  createImageToolResponse(base64Data: string, mimeType: string): {
    content: Array<{
      type: "image";
      data: string;
      mimeType: string;
    }>;
  } {
    return {
      content: [
        {
          type: "image",
          data: base64Data,
          mimeType: mimeType
        }
      ]
    };
  }

  // Static convenience methods for backward compatibility
  static createJSONToolResponse = (content: any) => new DefaultToolResponseFormatter().createJSONToolResponse(content);
  static createImageToolResponse = (base64Data: string, mimeType: string) => new DefaultToolResponseFormatter().createImageToolResponse(base64Data, mimeType);
}

// Export convenience functions for backward compatibility
export const createJSONToolResponse = DefaultToolResponseFormatter.createJSONToolResponse;
/**
 * Typed MCP tool-call envelope produced by `createStructuredToolResponse`.
 *
 * The payload `T` lives under `structuredContent`; the top level carries ONLY
 * the serialized `content` plus the two hoisted fields `success`/`error`. Every
 * other payload field (`found`, `viewHierarchy`, `screenshot`, …) exists solely
 * under `structuredContent`. Reading such a field off the top level silently
 * yields `undefined` — the envelope-vs-`structuredContent` dead-read bug class
 * (issue #2907). Read payload fields through {@link getStructuredField}, never
 * off the envelope directly.
 */
export interface StructuredToolResponse<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
  success?: boolean;
  error?: string;
}

/**
 * Creates a structured tool response for tools with outputSchema.
 * MCP tools with outputSchema must return structuredContent.
 * @param content The structured data that matches the tool's outputSchema
 * @returns A properly formatted tool response with both content and structuredContent
 */
export const createStructuredToolResponse = <T>(content: T): StructuredToolResponse<T> => {
  const response: StructuredToolResponse<T> = {
    content: [
      {
        type: "text",
        text: stringifyToolResponse(content)
      }
    ],
    structuredContent: content
  };
  if (content && typeof content === "object") {
    if ("success" in content) {
      response.success = (content as { success?: boolean }).success;
    }
    if ("error" in content) {
      response.error = (content as { error?: string }).error;
    }
  }
  return response;
};

/**
 * Reads the whole payload object off an MCP tool-call envelope (issue #2907).
 * The payload lives under `structuredContent`; the top level carries only the
 * serialized `content` and the hoisted `success`/`error`. This is the seam for
 * consumers that need the entire payload (e.g. to unwrap and inspect several
 * fields), the companion to {@link getStructuredField} for single-field reads.
 *
 * Returns `undefined` for null/undefined responses or a missing/non-object
 * `structuredContent`. Does NOT fall back to parsing the serialized text part —
 * callers that need that (older `content[0].text`-only results) must handle it
 * themselves.
 *
 * @param response The tool-call envelope (or anything envelope-shaped).
 */
export const getStructuredPayload = <T = Record<string, unknown>>(
  response: { structuredContent?: unknown } | null | undefined
): T | undefined => {
  const structuredContent = response?.structuredContent;
  if (structuredContent && typeof structuredContent === "object") {
    return structuredContent as T;
  }
  return undefined;
};

/**
 * The typed seam for reading a single payload field off an MCP tool-call
 * envelope (issues #2907 / #2932). Payload fields live under `structuredContent`,
 * not on the envelope top level — a raw `response.found` read is always
 * `undefined` and produces a silently-dead branch. Route every payload-field
 * read through this accessor so the read targets `structuredContent`, not the
 * envelope.
 *
 * Fully typed against a concrete payload `TPayload`: because `response` is a
 * `StructuredToolResponse<TPayload>`, the `key` is constrained to
 * `keyof TPayload` (a typo like `"founded"` is a **compile error**) and the
 * return type is `TPayload[K]` (a wrong `T` assertion is gone — the value type
 * is inferred). This closes the stringly-typed hole the earlier loose
 * `getStructuredField<T>(response, "key")` left open (issue #2932): both the
 * envelope-vs-payload half AND the typo/wrong-type half are now compiler-caught.
 *
 * Still a *structural* guard at runtime: only an own key resolves, so an
 * inherited prototype key never leaks through. Returns `undefined` for
 * null/undefined responses, a missing or non-object `structuredContent`, or an
 * absent (own) field.
 *
 * Requires a fully-typed `StructuredToolResponse<TPayload>`, not a bare
 * envelope-shaped literal — narrow an `any`-boundary value at the registry
 * boundary first (e.g. `ToolRegistry.getInternalTool` or
 * `narrowInternalToolEnvelope`, issue #3222). Caveat: keep `TPayload` a *closed*
 * type; if it
 * carries a string index signature, `keyof TPayload` widens to include `string`
 * and the typo-protection silently evaporates.
 *
 * @param response The typed tool-call envelope.
 * @param key The payload field to read from `structuredContent` (keyof TPayload).
 */
export const getStructuredField = <TPayload, K extends keyof TPayload & string>(
  response: StructuredToolResponse<TPayload> | null | undefined,
  key: K
): TPayload[K] | undefined => {
  const structuredContent = response?.structuredContent;
  if (structuredContent && typeof structuredContent === "object") {
    if (!Object.hasOwn(structuredContent, key)) {
      return undefined;
    }
    return (structuredContent as TPayload)[key];
  }
  return undefined;
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "DeviceLostError") {
      throw signal.reason;
    }
    throw new Error(OPERATION_CANCELLED_MESSAGE);
  }
};
