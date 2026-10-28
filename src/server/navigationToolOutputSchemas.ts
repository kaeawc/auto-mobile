import { z } from "zod/v4";
import { lifecycleActionOutputFields } from "./toolOutputSchemas/actions";

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

const modalStackOutputSchema = () =>
  z.array(
    z
      .object({
        type: z.enum(["bottomsheet", "dialog", "popup", "menu", "overlay"]),
        identifier: z.string().optional(),
        layer: z.number(),
        windowId: z.number().optional(),
        windowType: z.string().optional(),
      })
      .passthrough(),
  );

/** The UI state recorded with a tool call (selected tabs, modals, scroll target). */
const uiStateOutputSchema = () =>
  z
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
      modalStack: modalStackOutputSchema().optional(),
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
          uiState: uiStateOutputSchema().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** The navigation graph `explore` exports after its final read. */
const exportedGraphOutputSchema = () =>
  z
    .object({
      appId: z.string().nullable(),
      nodes: z.array(
        z
          .object({
            screenName: z.string(),
            firstSeenAt: z.number(),
            lastSeenAt: z.number(),
            visitCount: z.number(),
            modalStack: modalStackOutputSchema().optional(),
            backStackDepth: z.number().optional(),
            taskId: z.number().optional(),
          })
          .passthrough(),
      ),
      edges: z.array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            interaction: z
              .object({
                toolName: z.string(),
                // The recorded tool call's arguments, replayed verbatim.
                args: z.record(z.string(), z.unknown()),
                timestamp: z.number(),
                deviceId: z.string().optional(),
                dispatchedAt: z.number().optional(),
                uiState: uiStateOutputSchema().optional(),
              })
              .passthrough()
              .optional(),
            timestamp: z.number(),
            edgeType: z.enum(["tool", "back", "unknown"]),
            uiState: uiStateOutputSchema().optional(),
            fromModalStack: modalStackOutputSchema().optional(),
            toModalStack: modalStackOutputSchema().optional(),
          })
          .passthrough(),
      ),
      currentScreen: z.string().nullable(),
    })
    .passthrough();

/**
 * One shape for a completed (or cancelled) exploration and a dry run's plan; setup
 * failures throw. Only what both outcomes always carry is required (`message`,
 * `success`, `durationMs`), so a spilled response keeps every required field; the
 * outcome-specific fields are optional. A dry run carries `dryRun: true` and its plan,
 * a completed run its counts, graph and coverage. Either may embed the observation it
 * read, finalized like any action's.
 */
export const exploreResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    success: z.boolean(),
    durationMs: z.number(),
    // Completed (or cancelled) exploration.
    cancelled: z.boolean().optional(),
    interactionsPerformed: z.number().int().nonnegative().optional(),
    screensDiscovered: z.number().int().nonnegative().optional(),
    edgesAdded: z.number().int().nonnegative().optional(),
    navigationGraph: exportedGraphOutputSchema().optional(),
    explorationPath: z.array(z.string()).optional(),
    coverage: z
      .object({
        totalScreens: z.number().int().nonnegative(),
        exploredScreens: z.number().int().nonnegative(),
        percentage: z.number(),
      })
      .passthrough()
      .optional(),
    elementSelections: z
      .array(
        z
          .object({
            text: z.string().optional(),
            resourceId: z.string().optional(),
            className: z.string().optional(),
            score: z.number(),
            novelty: z.number(),
            coverage: z.number(),
            finalScore: z.number(),
          })
          .passthrough(),
      )
      .optional(),
    stopReason: z.string().optional(),
    graphTraversal: z
      .object({
        nodesVisited: z.number().int().nonnegative(),
        totalNodes: z.number().int().nonnegative(),
        edgesTraversed: z.number().int().nonnegative(),
        totalEdges: z.number().int().nonnegative(),
        edgeValidationResults: z.array(
          z
            .object({
              edgeKey: z.string(),
              fromScreen: z.string(),
              expectedTo: z.string(),
              actualTo: z.string().nullable(),
              success: z.boolean(),
              skipped: z.boolean().optional(),
              timestamp: z.number(),
              error: z.string().optional(),
              matchConfidence: z.number().optional(),
            })
            .passthrough(),
        ),
        coveragePercentage: z.number(),
      })
      .passthrough()
      .optional(),
    // Dry run.
    dryRun: z.literal(true).optional(),
    currentScreen: z
      .object({ name: z.string(), interactableElements: z.number().int().nonnegative() })
      .passthrough()
      .optional(),
    plannedInteractions: z
      .array(
        z
          .object({
            order: z.number().int(),
            action: z.enum(["tapOn", "swipeOn"]),
            target: z
              .object({ type: z.enum(["text", "id", "coordinates"]), value: z.string() })
              .passthrough(),
            reason: z.string(),
            predictedOutcome: z
              .object({ screen: z.string(), confidence: z.number() })
              .passthrough(),
            whitelistStatus: z.enum(["allowed", "blocked", "unknown"]),
          })
          .passthrough(),
      )
      .optional(),
    estimatedCoverage: z
      .object({
        screensToVisit: z.array(z.string()),
        newScreensExpected: z.number().int(),
        existingScreensToRevisit: z.number().int().nonnegative(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
