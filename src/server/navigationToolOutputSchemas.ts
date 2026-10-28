import { z } from "zod/v4";

/**
 * Built per field: a schema instance reused across fields is advertised as a `$ref`
 * the tool schema cannot resolve.
 */
const elementReferenceOutputSchema = () =>
  z
    .object({
      text: z.string().optional(),
      resourceId: z.string().optional(),
      contentDesc: z.string().optional(),
    })
    .passthrough();

/** The UI state recorded with a tool call (selected tabs, modals, scroll target). */
const uiStateOutputSchema = z
  .object({
    selectedElements: z.array(
      z
        .object({
          text: z.string().optional(),
          resourceId: z.string().optional(),
          contentDesc: z.string().optional(),
          selectedState: z
            .object({
              method: z.enum(["accessibility", "visual"]),
              confidence: z.number(),
              reason: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
    destinationId: z.string().optional(),
    modalStack: z
      .array(
        z
          .object({
            type: z.enum(["bottomsheet", "dialog", "popup", "menu", "overlay"]),
            identifier: z.string().optional(),
            layer: z.number(),
            windowId: z.number().optional(),
            windowType: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    scrollPosition: z
      .object({
        container: elementReferenceOutputSchema().optional(),
        targetElement: elementReferenceOutputSchema(),
        direction: z.enum(["up", "down", "left", "right"]),
        speed: z.enum(["slow", "normal", "fast"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * One shape for both outcomes: a success always carries `message`, a failure always
 * carries `error` (the handler fills either default) and marks the envelope `isError`.
 * A single object keeps the required fields a spilled response must retain.
 */
export const navigateToResultSchema = z
  .object({
    message: z.string().optional(),
    success: z.boolean(),
    error: z.string().optional(),
    currentScreen: z.string().nullable(),
    targetScreen: z.string(),
    stepsExecuted: z.number().int().nonnegative(),
    path: z.array(z.string()).optional(),
    partialPath: z.array(z.string()).optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

/** Read failures throw; the graph is scoped to `requestedAppId`, else the observed app. */
export const getNavigationGraphResultSchema = z
  .object({
    message: z.string(),
    requestedAppId: z.string().nullable(),
    observedAppId: z.string().nullable(),
    currentScreen: z.string().nullable(),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    knownEdges: z.number().int().nonnegative(),
    unknownEdges: z.number().int().nonnegative(),
    screens: z.array(
      z.object({ name: z.string(), visitCount: z.number(), lastVisited: z.string() }).passthrough(),
    ),
    transitions: z.array(
      z
        .object({
          from: z.string(),
          to: z.string(),
          type: z.enum(["tool", "back", "unknown"]),
          tool: z.string().optional(),
          // The recorded tool call's arguments, replayed verbatim.
          args: z.record(z.string(), z.unknown()).optional(),
          uiState: uiStateOutputSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
