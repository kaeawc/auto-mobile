import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  ActionableError,
  BootedDevice,
  Element,
  HighlightOperationResult,
  HighlightShape,
  Platform,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../models";
import { highlightShapeSchema, VisualHighlightClient } from "../features/debug/VisualHighlight";
import { generateHighlightId, recordVideoRecordingHighlightAdded } from "./videoRecordingManager";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { DefaultElementSelector } from "../features/utility/DefaultElementSelector";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../utils/PerformanceTracker";
import {
  elementContainerSchema,
  elementIdTextFieldsSchema,
  elementSelectionStrategySchema,
  validateElementIdTextSelector,
} from "./elementSelectorSchemas";
import { boundsEqual } from "../utils/bounds";

const highlightBaseSchema = z
  .object({
    platform: platformSchema,
    deviceId: z.string().optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Highlight request timeout ms (default: 5000)"),
    description: z.string().optional().describe("Optional description of the highlight"),
    shape: highlightShapeSchema.optional().describe("Optional highlight shape definition"),
    elementId: elementIdTextFieldsSchema.shape.elementId,
    text: elementIdTextFieldsSchema.shape.text,
    container: elementContainerSchema.optional().describe("Scope search to a container"),
    containerOf: z.boolean().optional().describe("Highlight selected element's container"),
    selectionStrategy: elementSelectionStrategySchema
      .optional()
      .describe("Selection strategy when multiple match (default: first)"),
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
    }

    if (hasSelector) {
      validateElementIdTextSelector(value, ctx);
    }
  },
);

export type HighlightArgs = z.infer<typeof highlightSchema>;

const toHighlightResponse = (result: HighlightOperationResult) =>
  createJSONToolResponse({
    success: result.success,
    error: result.error ?? undefined,
  });

const toHighlightErrorResponse = (error: unknown) => {
  const message = error instanceof ActionableError ? error.message : String(error);
  return createJSONToolResponse({
    success: false,
    error: message,
  });
};

const DEFAULT_HIERARCHY_TIMEOUT_MS = 10000;

const findContainerForElement = (
  viewHierarchy: ViewHierarchyResult,
  target: Element,
): Element | null => {
  const parser = new DefaultElementParser();
  const roots: ViewHierarchyNode[] = [
    ...parser.extractRootNodes(viewHierarchy),
    ...parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
  ];
  const targetResourceId =
    typeof target["resource-id"] === "string" ? target["resource-id"] : undefined;
  const targetLabel =
    typeof target.text === "string"
      ? target.text
      : typeof target["content-desc"] === "string"
        ? target["content-desc"]
        : undefined;
  let container: Element | null = null;

  const resolveContainerFromStack = (stack: ViewHierarchyNode[]): Element | null => {
    for (let i = stack.length - 2; i >= 0; i -= 1) {
      const parsedParent = parser.parseNodeBounds(stack[i]);
      if (!parsedParent) {
        continue;
      }
      if (!boundsEqual(parsedParent.bounds, target.bounds)) {
        return parsedParent;
      }
    }
    return null;
  };

  const matchesTarget = (node: ViewHierarchyNode, parsed: Element): boolean => {
    if (!boundsEqual(parsed.bounds, target.bounds)) {
      return false;
    }
    const nodeProps = parser.extractNodeProperties(node);
    const nodeResourceId = nodeProps["resource-id"];
    if (targetResourceId && nodeResourceId !== targetResourceId) {
      return false;
    }
    if (!targetResourceId && targetLabel) {
      const nodeLabel =
        nodeProps.text || nodeProps["content-desc"] || nodeProps["ios-accessibility-label"];
      if (nodeLabel !== targetLabel) {
        return false;
      }
    }
    return true;
  };

  const traverse = (node: ViewHierarchyNode, stack: ViewHierarchyNode[]) => {
    if (container) {
      return;
    }
    stack.push(node);
    const parsed = parser.parseNodeBounds(node);
    if (parsed && matchesTarget(node, parsed)) {
      container = resolveContainerFromStack(stack);
    }

    const children = node.node;
    if (!container && children) {
      if (Array.isArray(children)) {
        for (const child of children) {
          traverse(child, stack);
          if (container) {
            break;
          }
        }
      } else {
        traverse(children, stack);
      }
    }
    stack.pop();
  };

  for (const root of roots) {
    traverse(root, []);
    if (container) {
      break;
    }
  }

  return container;
};

const resolveHighlightShapeFromSelector = async (
  device: BootedDevice,
  args: HighlightArgs,
  dependencies: HighlightToolDependencies = {},
): Promise<HighlightShape> => {
  if (!args.elementId && !args.text) {
    throw new ActionableError("highlight requires elementId or text when shape is not provided.");
  }

  const viewHierarchyClient = dependencies.viewHierarchyClientFactory
    ? dependencies.viewHierarchyClientFactory(device)
    : createDefaultViewHierarchyClient(device);
  const hierarchyTimeout = args.timeoutMs ?? DEFAULT_HIERARCHY_TIMEOUT_MS;
  const syncResult = await viewHierarchyClient.requestHierarchySync(
    new NoOpPerformanceTracker(),
    false,
    undefined,
    hierarchyTimeout,
  );
  if (!syncResult) {
    throw new ActionableError("Unable to retrieve view hierarchy for highlight.");
  }
  const viewHierarchy = viewHierarchyClient.convertToViewHierarchyResult(syncResult.hierarchy);
  const finder = new DefaultElementFinder();
  const elementSelector = new DefaultElementSelector(finder);
  const container = args.container ?? null;

  if (container && !finder.hasContainerElement(viewHierarchy, container)) {
    throw new ActionableError("Highlight container not found in the view hierarchy.");
  }

  const strategy = args.selectionStrategy ?? "first";
  const selection = args.text
    ? elementSelector.selectByText(viewHierarchy, args.text, {
        container,
        partialMatch: true,
        caseSensitive: false,
        strategy,
      })
    : elementSelector.selectByResourceId(viewHierarchy, args.elementId as string, {
        container,
        partialMatch: false,
        strategy,
      });

  const selectedElement = selection.element;
  if (!selectedElement) {
    throw new ActionableError("Unable to find an element that matches the highlight selector.");
  }

  const highlightElement = args.containerOf
    ? findContainerForElement(viewHierarchy, selectedElement)
    : selectedElement;
  if (!highlightElement) {
    throw new ActionableError("Unable to resolve a container for the selected element.");
  }

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

interface HighlightViewHierarchyClient {
  requestHierarchySync(
    perf: PerformanceTracker,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ hierarchy: unknown } | null>;
  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult;
}

interface HighlightToolDependencies {
  highlightClientFactory?: () => VisualHighlightClient;
  viewHierarchyClientFactory?: (device: BootedDevice) => HighlightViewHierarchyClient;
  generateHighlightId?: () => string;
}

const createDefaultViewHierarchyClient = (device: BootedDevice): HighlightViewHierarchyClient => {
  if (device.platform === "android") {
    return AndroidCtrlProxyClient.getInstance(
      device,
      defaultAdbClientFactory,
    ) as HighlightViewHierarchyClient;
  }
  if (device.platform === "ios") {
    return IOSCtrlProxyClient.getInstance(device) as HighlightViewHierarchyClient;
  }
  throw new ActionableError(`Visual highlights are not supported on ${device.platform} devices.`);
};

export function registerHighlightTools(dependencies: HighlightToolDependencies = {}) {
  const highlightHandler = async (device: BootedDevice, args: HighlightArgs) => {
    const highlightClient = dependencies.highlightClientFactory
      ? dependencies.highlightClientFactory()
      : new VisualHighlightClient();
    const options = {
      device,
      deviceId: args.deviceId ?? device.deviceId,
      platform: args.platform as Platform,
      sessionUuid: args.sessionUuid,
      timeoutMs: args.timeoutMs,
    };

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
      return toHighlightErrorResponse(error);
    }
  };

  ToolRegistry.registerDeviceAware(
    "highlight",
    "Draw a visual highlight around a UI element.",
    highlightSchema,
    highlightHandler,
    { defaultEnabled: false },
  );
}
