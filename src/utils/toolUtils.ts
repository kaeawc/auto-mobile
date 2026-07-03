/**
 * Utility functions for tool handlers
 */
import { OPERATION_CANCELLED_MESSAGE } from "./constants";

const stripAccessibilityExtras = (key: string, value: unknown): unknown => {
  if (key === "extras") {
    return undefined;
  }
  return value;
};

export const stringifyToolResponse = (content: unknown): string => {
  return JSON.stringify(content, stripAccessibilityExtras, 2);
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
 * envelope (issue #2907). Payload fields live under `structuredContent`, not on
 * the envelope top level — a raw `response.found` read is always `undefined`
 * and produces a silently-dead branch. Route every payload-field read through
 * this accessor so the read targets `structuredContent`, not the envelope.
 *
 * This is a *structural* guard: it guarantees you read from `structuredContent`
 * and not the envelope top level, and only an own key resolves. It does NOT
 * validate that `key` exists on the payload or that the value matches `T` — the
 * caller asserts `T`, so a wrong `key` or `T` still yields a silent `undefined`
 * / mistyped value. Making those a compile error requires a fully typed handler
 * boundary (see follow-up); this accessor closes the envelope-vs-payload half.
 *
 * Accepts a loosely-typed envelope (handlers hand back `any`), safely narrows,
 * and returns `undefined` for null/undefined responses, a missing or
 * non-object `structuredContent`, or an absent (or non-own) field.
 *
 * @param response The tool-call envelope (or anything envelope-shaped).
 * @param key The payload field to read from `structuredContent`.
 */
export const getStructuredField = <T = unknown>(
  response: { structuredContent?: unknown } | null | undefined,
  key: string
): T | undefined => {
  const structuredContent = response?.structuredContent;
  if (structuredContent && typeof structuredContent === "object") {
    if (!Object.hasOwn(structuredContent, key)) {
      return undefined;
    }
    return (structuredContent as Record<string, unknown>)[key] as T | undefined;
  }
  return undefined;
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new Error(OPERATION_CANCELLED_MESSAGE);
  }
};
