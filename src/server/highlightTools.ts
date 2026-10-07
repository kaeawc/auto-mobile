import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import { createJSONToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  ActionableError,
  BootedDevice,
  Element,
  HighlightOperationResult,
  HighlightShape,
  Platform,
  ViewHierarchyResult,
} from "../models";
import { highlightShapeSchema, VisualHighlightClient } from "../features/debug/VisualHighlight";
import { generateHighlightId, recordVideoRecordingHighlightAdded } from "./videoRecordingManager";
import type { HierarchyCapture, HierarchySnapshot } from "../features/observe/HierarchyCapture";
import {
  createDeviceHierarchyCapture,
  type HierarchySyncClient,
} from "../features/observe/DeviceHierarchyCapture";
import {
  ElementResolver,
  matchedSourceNode,
  type ElementResolution,
} from "../features/utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../features/utility/SearchableNode";
import { scopeHierarchyForSelector } from "../features/observe/hierarchyTarget";
import { DefaultElementParser } from "../features/utility/ElementParser";
import {
  elementContainerSchema,
  elementIdTextFieldsSchema,
  hierarchyTargetSchema,
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
  validateElementIdTextSelector,
} from "./elementSelectorSchemas";
import { logger } from "../utils/logger";
import { boundsEqual } from "../utils/bounds";

const highlightBaseSchema = z
  .object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    deviceId: z.string().optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Highlight request timeout ms (default: 5000)"),
    description: z.string().optional().describe("Optional description of the highlight"),
    shape: highlightShapeSchema.optional().describe("Optional bounds for a red hand-drawn circle"),
    elementId: elementIdTextFieldsSchema.shape.elementId,
    text: elementIdTextFieldsSchema.shape.text,
    container: nestedElementContainerSchema
      .or(elementContainerSchema)
      .optional()
      .describe(
        "Nested container scope; outermost resolves first, with per-level index and selectionStrategy",
      ),
    containerOf: z.boolean().optional().describe("Highlight selected element's container"),
    selectionStrategy: resolverSelectionStrategySchema
      .optional()
      .describe("Selection strategy when multiple match (default: first)"),
    target: hierarchyTargetSchema.optional(),
  })
  .strict();

export const highlightSchema = addDeviceTargetingToSchema(highlightBaseSchema).superRefine(
  (value, ctx) => {
    const hasShape = Boolean(value.shape);
    const hasElementId = value.elementId !== undefined;
    const hasText = value.text !== undefined;
    const hasSelector = hasElementId || hasText;

    if (hasShape === hasSelector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either shape or selector (elementId/text), but not both",
      });
    }

    if (!hasSelector) {
      if (value.container) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "container can only be used with selector",
        });
      }
      if (value.containerOf !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "containerOf can only be used with selector",
        });
      }
      if (value.selectionStrategy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selectionStrategy can only be used with selector",
        });
      }
      if (value.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "target can only be used with selector",
        });
      }
    }

    if (hasSelector) {
      validateElementIdTextSelector(value, ctx);
    }
  },
);

export type HighlightArgs = z.infer<typeof highlightSchema>;

const toHighlightResponse = (result: HighlightOperationResult) =>
  withIsErrorOnFailure(
    createJSONToolResponse({
      success: result.success,
      error: result.error ?? undefined,
    }),
    result.success,
  );

const toHighlightErrorResponse = (error: unknown) => {
  const message = error instanceof ActionableError ? error.message : String(error);
  return withIsErrorOnFailure(createJSONToolResponse({ success: false, error: message }), false);
};

const DEFAULT_HIERARCHY_TIMEOUT_MS = 10000;

const findContainerForElement = (
  nodes: readonly SearchableEntry[],
  target: SearchableEntry,
): Element | null => {
  let parent = target.parentIndex;
  while (parent !== undefined) {
    const node = nodes[parent];
    if (node.element && target.bounds && !boundsEqual(node.element.bounds, target.bounds)) {
      return node.element;
    }
    parent = node.parentIndex;
  }
  return null;
};

const captureHighlightHierarchy = (
  device: BootedDevice,
  args: HighlightArgs,
  dependencies: HighlightToolDependencies,
): Promise<HierarchySnapshot> => {
  if (!args.elementId && !args.text) {
    throw new ActionableError("highlight requires elementId or text when shape is not provided.");
  }

  const capture =
    dependencies.hierarchyCaptureFactory?.(device) ??
    createDeviceHierarchyCapture(device, {
      syncClientFactory: dependencies.viewHierarchyClientFactory,
    });
  return capture.capture({
    freshness: "fresh",
    timeoutMs: args.timeoutMs ?? DEFAULT_HIERARCHY_TIMEOUT_MS,
  });
};

/** Resolve the highlight selector in the app or the AutoMobile overlay only (issue #9305). */
const targetScopedSnapshot = (
  snapshot: HierarchySnapshot,
  target: HighlightArgs["target"],
): HierarchySnapshot => {
  if (target === undefined) {
    return snapshot;
  }
  const hierarchy = scopeHierarchyForSelector(snapshot.hierarchy, target);
  return hierarchy === snapshot.hierarchy
    ? snapshot
    : { ...snapshot, hierarchy, nodes: new SearchableHierarchy().project(hierarchy) };
};

const selectHighlightElement = (
  device: BootedDevice,
  args: HighlightArgs,
  snapshot: HierarchySnapshot,
  resolution: ElementResolution,
): Element => {
  if (resolution.error) {
    throw new ActionableError(resolution.error);
  }
  if (!resolution.chosen?.element) {
    throw new ActionableError("Unable to find an element that matches the highlight selector.");
  }
  const selected =
    args.text && (args.containerOf || device.platform !== "android")
      ? (matchedSourceNode(resolution, { text: args.text }) ?? resolution.chosen)
      : resolution.chosen;
  const highlightElement = args.containerOf
    ? findContainerForElement(snapshot.nodes, selected)
    : selected.element;
  if (!highlightElement) {
    throw new ActionableError("Unable to resolve a container for the selected element.");
  }

  return highlightElement;
};

const resolveHighlightShapeFromSelector = async (
  device: BootedDevice,
  args: HighlightArgs,
  dependencies: HighlightToolDependencies = {},
): Promise<HighlightShape> => {
  const snapshot = targetScopedSnapshot(
    await captureHighlightHierarchy(device, args, dependencies),
    args.target,
  );
  const viewHierarchy = snapshot.hierarchy;
  const resolution = new ElementResolver().resolve(
    { id: snapshot.captureId, nodes: snapshot.nodes },
    {
      elementId: args.elementId,
      text: args.text,
      container: args.container,
      selectionStrategy: args.selectionStrategy,
    },
    {
      action: "highlight",
      viewport:
        viewHierarchy.screenWidth && viewHierarchy.screenHeight
          ? { width: viewHierarchy.screenWidth, height: viewHierarchy.screenHeight }
          : undefined,
    },
  );
  const highlightElement = selectHighlightElement(device, args, snapshot, resolution);

  const bounds = highlightElement.bounds;
  const width = Math.round(bounds.right - bounds.left);
  const height = Math.round(bounds.bottom - bounds.top);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ActionableError("Selected element bounds are invalid for highlight.");
  }

  const highlightBounds = {
    x: Math.round(bounds.left),
    y: Math.round(bounds.top),
    width,
    height,
  };

  // The in-app iOS SDK draws into the target app's own view space, so it must
  // know the device/observation coordinate space these bounds came from to map
  // them correctly. Always attach source dims on the iOS path so the SDK never
  // falls back to drawing raw daemon coordinates (issue #2682). Android draws its
  // overlay in observation space, so no source dims are needed there.
  if (device.platform === "ios") {
    const sourceDimensions = resolveSourceDimensions(viewHierarchy);
    if (sourceDimensions) {
      return {
        type: "circle",
        bounds: { ...highlightBounds, ...sourceDimensions },
      };
    }
  }

  return {
    type: "circle",
    bounds: highlightBounds,
  };
};

const resolveSourceDimensions = (
  viewHierarchy: ViewHierarchyResult,
): { sourceWidth: number; sourceHeight: number } | null => {
  if (
    typeof viewHierarchy.screenWidth === "number" &&
    typeof viewHierarchy.screenHeight === "number" &&
    viewHierarchy.screenWidth > 0 &&
    viewHierarchy.screenHeight > 0
  ) {
    return {
      sourceWidth: Math.round(viewHierarchy.screenWidth),
      sourceHeight: Math.round(viewHierarchy.screenHeight),
    };
  }

  const parser = new DefaultElementParser();
  let maxWidth = 0;
  let maxHeight = 0;
  for (const root of parser.extractRootNodes(viewHierarchy)) {
    const parsed = parser.parseNodeBounds(root);
    if (!parsed) {
      continue;
    }
    maxWidth = Math.max(maxWidth, parsed.bounds.right - parsed.bounds.left);
    maxHeight = Math.max(maxHeight, parsed.bounds.bottom - parsed.bounds.top);
  }

  if (maxWidth > 0 && maxHeight > 0) {
    return { sourceWidth: Math.round(maxWidth), sourceHeight: Math.round(maxHeight) };
  }

  return null;
};

interface HighlightToolDependencies {
  hierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
  highlightClientFactory?: () => VisualHighlightClient;
  viewHierarchyClientFactory?: (device: BootedDevice) => HierarchySyncClient;
  generateHighlightId?: () => string;
}

/**
 * #6154 follow-up: `platform` is optional on the wire (resolved from
 * deviceId/session), so `args.platform` can be `undefined` here even though
 * ToolRegistry has already resolved `device`. Build the `VisualHighlightClient`
 * options from the resolved `device.platform` — never the raw request field —
 * or its device/platform mismatch check spuriously rejects every call that
 * omitted `platform`. Exported standalone so the resolution itself (not just
 * the end-to-end handler) is directly testable.
 */
export function resolveHighlightClientOptions(
  device: BootedDevice,
  args: Pick<HighlightArgs, "deviceId" | "sessionUuid" | "timeoutMs">,
): {
  device: BootedDevice;
  deviceId: string;
  platform: Platform;
  sessionUuid?: string;
  timeoutMs?: number;
} {
  return {
    device,
    deviceId: args.deviceId ?? device.deviceId,
    platform: device.platform,
    sessionUuid: args.sessionUuid,
    timeoutMs: args.timeoutMs,
  };
}

export function registerHighlightTools(dependencies: HighlightToolDependencies = {}) {
  const highlightHandler = async (device: BootedDevice, args: HighlightArgs) => {
    const highlightClient = dependencies.highlightClientFactory
      ? dependencies.highlightClientFactory()
      : new VisualHighlightClient();
    const options = resolveHighlightClientOptions(device, args);

    try {
      const highlightId = dependencies.generateHighlightId
        ? dependencies.generateHighlightId()
        : generateHighlightId();
      const resolvedShape =
        args.shape ?? (await resolveHighlightShapeFromSelector(device, args, dependencies));
      const result = await highlightClient.addHighlight(highlightId, resolvedShape, options);
      await recordVideoRecordingHighlightAdded(device, {
        description: args.description,
        shape: resolvedShape,
      });
      return toHighlightResponse(result);
    } catch (error) {
      logger.warn("[highlight] Failed to highlight element", error);
      return toHighlightErrorResponse(error);
    }
  };

  ToolRegistry.registerDeviceAware(
    "highlight",
    "Draw a red hand-drawn circle around a UI element.",
    highlightSchema,
    highlightHandler,
    { defaultEnabled: false },
  );
}
