import type { z } from "zod/v4";
import type {
  tapAtSchema,
  tapAnySchema,
  dragAndDropSchema,
  swipeOnSchema,
  pinchOnSchema,
  sendKeysSchema,
  openLinkSchema,
  clipboardSchema,
} from "./interactionTools";
import type {
  keyboardTool,
  selectAllTextTool,
  pressButtonTool,
  wakeAndUnlockTool,
  shakeTool,
  recentAppsTool,
  rotateTool,
} from "./interactionTools";
import type { ElementContainerSelector } from "../models/PinchOnOptions";
import type { HierarchyLayer } from "../models/HierarchyLayer";
/**
 * Type definitions for interaction tools.
 * Extracted from interactionTools.ts for maintainability.
 */
import type { Platform, ElementSelectionStrategy } from "../models";

// ============================================================================
// Tool Argument Types
// ============================================================================

// #6154: `platform` is optional on every one of these tools' wire schemas
// (resolved from deviceId/session when omitted), so the hand-written arg
// types below must match it — a typed caller could not otherwise omit it.
// `TapOnArgs.platform` is optional too (#11824: the registry now checks handler
// arguments against the schema output).
export type SelectAllTextArgs = z.output<typeof selectAllTextTool.schema>;

export type PressButtonArgs = z.output<typeof pressButtonTool.schema>;

export type SendKeysArgs = z.output<typeof sendKeysSchema>;

export type WakeAndUnlockArgs = z.output<typeof wakeAndUnlockTool.schema>;

export type OpenLinkArgs = z.output<typeof openLinkSchema>;

export interface TapOnArgs {
  display?: string;
  selector: {
    elementId?: string;
    testTag?: string;
    text?: string;
    textAny?: string[];
    accessibilityLink?: string;
  };
  sibling?: boolean;
  container?: ElementContainerSelector;
  selectionStrategy?: ElementSelectionStrategy;
  index?: number;
  action: "tap" | "doubleTap" | "longPress" | "focus";
  duration?: number;
  searchUntil?: {
    duration?: number;
  };
  platform?: Platform;
  preTapStability?: boolean;
  retryIfNoChange?: boolean;
  ensureTap?: boolean;
  ensureChecked?: boolean;
  subtext?: {
    text: string;
    occurrence?: number;
  };
  layer?: HierarchyLayer;
  raw?: boolean;
  project?: "full" | "skeleton";
}

// The parsed wire schema; its exclusivity refinement (image xor x/y) is narrowed where the
// options are built.
export type TapAtArgs = z.output<typeof tapAtSchema> & {
  __tapAtPlanContext?: import("../models/TapAtGeometry").TapAtPlanContext;
  __tapAtRecordingContext?: import("../models/TapAtGeometry").TapAtPlanContext;
};

export type TapAnyArgs = z.output<typeof tapAnySchema>;

export type DragAndDropArgs = z.output<typeof dragAndDropSchema>;

export type SwipeOnArgs = z.output<typeof swipeOnSchema>;

export type PinchOnArgs = z.output<typeof pinchOnSchema>;

export type ShakeArgs = z.output<typeof shakeTool.schema>;

export type KeyboardArgs = z.output<typeof keyboardTool.schema>;

export const KEYBOARD_READ_ACTIONS: ReadonlySet<string> = new Set([
  "detect",
  "listImes",
  "listProfiles",
]);

export type RecentAppsArgs = z.output<typeof recentAppsTool.schema>;

export type RotateArgs = z.output<typeof rotateTool.schema>;

export type ClipboardArgs = z.output<typeof clipboardSchema>;

export type {
  SystemTrayNotificationArgs,
  SystemTrayArgs,
} from "../features/systemTray/systemTrayTypes";
