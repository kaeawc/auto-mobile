import {
  SystemTrayAdb,
  SystemTrayDependencies,
  SystemTrayObserver,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
  waitForNotificationMatch,
} from "../features/systemTray/systemTrayHelpers";
import { defineDeviceTool } from "./defineTool";
import { dragPathHandler, dragPathSchema } from "./dragPathTool";
import { hoverAtHandler, hoverAtSchema } from "./hoverAtTool";
import {
  createClipboardHandler,
  createKeyboardHandler,
  createOpenLinkHandler,
  createRecentAppsHandler,
  createSendKeysHandler,
  createShakeHandler,
  createWakeAndUnlockHandler,
  homeScreenHandler,
  systemTrayHandler,
} from "./interactionToolHandlers";
import type { InteractionToolDependencies } from "./interactionTools/dependencies";
import {
  pressButtonHandler,
  rotateHandler,
  selectAllTextHandler,
  setPostureHandler,
} from "./interactionTools/deviceHandlers";
import {
  KEYBOARD_READ_ACTIONS,
  homeScreenInput,
  keyboardInput,
  openLinkSchema,
  pressButtonInput,
  recentAppsInput,
  rotateInput,
  selectAllTextInput,
  setPostureSchema,
  shakeInput,
  systemTraySchema,
  wakeAndUnlockInput,
} from "./interactionTools/deviceSchemas";
import {
  dragAndDropHandler,
  pinchOnHandler,
  swipeOnHandler,
} from "./interactionTools/gestureHandlers";
import { dragAndDropSchema, pinchOnSchema, swipeOnSchema } from "./interactionTools/gestureSchemas";
import { clipboardSchema, sendKeysSchema } from "./interactionTools/inputSchemas";
import {
  hitTestHandler,
  tapAnyHandler,
  tapAtHandler,
  tapOnHandler,
} from "./interactionTools/tapHandlers";
import {
  hitTestSchema,
  tapAnySchema,
  tapAtSchema,
  tapOnSchema,
} from "./interactionTools/tapSchemas";
import type {
  ClipboardArgs,
  DragAndDropArgs,
  KeyboardArgs,
  OpenLinkArgs,
  PinchOnArgs,
  PressButtonArgs,
  RecentAppsArgs,
  RotateArgs,
  SelectAllTextArgs,
  SendKeysArgs,
  ShakeArgs,
  SwipeOnArgs,
  SystemTrayArgs,
  SystemTrayNotificationArgs,
  TapAnyArgs,
  TapOnArgs,
  WakeAndUnlockArgs,
} from "./interactionToolTypes";
import {
  clipboardResultSchema,
  dragAndDropResultSchema,
  homeScreenResultSchema,
  pinchOnResultSchema,
  recentAppsResultSchema,
  selectAllTextResultSchema,
  shakeResultSchema,
  systemTrayResultSchema,
} from "./interactionToolOutputSchemas";
import {
  keyboardResultSchema,
  openLinkResultSchema,
  pressButtonResultSchema,
  rotateResultSchema,
  sendKeysResultSchema,
  setPostureResultSchema,
  tapOnResultSchema,
  wakeAndUnlockResultSchema,
} from "./toolOutputSchemas";
import { ToolRegistry } from "./toolRegistry";
import { ANSWERS_SYSTEM_ALERTS, PLAN_RELEVANT, PLAN_SKELETON } from "./toolRegistryTypes";

// Re-export types for backward compatibility
export type {
  ClipboardArgs,
  DragAndDropArgs,
  KeyboardArgs,
  OpenLinkArgs,
  PinchOnArgs,
  PressButtonArgs,
  RecentAppsArgs,
  RotateArgs,
  SelectAllTextArgs,
  SendKeysArgs,
  ShakeArgs,
  SwipeOnArgs,
  SystemTrayArgs,
  SystemTrayNotificationArgs,
  TapAnyArgs,
  TapOnArgs,
  WakeAndUnlockArgs,
};

// Re-export system tray helpers for backward compatibility
export type { SystemTrayAdb, SystemTrayDependencies, SystemTrayObserver };

export { resetSystemTrayDependencies, setSystemTrayDependencies, waitForNotificationMatch };

/**
 * UI interactions that may cause in-app navigation (the navigation recorder records them); they
 * also run behind the device's `systemAlerts` policy.
 */
const NAV = { recordsNavigation: true, ...ANSWERS_SYSTEM_ALERTS } as const;

const NAV_PLAN_SKELETON = { ...NAV, ...PLAN_SKELETON } as const;

export const pressButtonTool = defineDeviceTool({
  name: "pressButton",
  description:
    "Press a device or navigation button. On iOS simulators, volume_up, volume_down, and power use hardware-button events; menu is unsupported on iOS. action and camera are iOS-only (Action button, Camera Control) and return unsupported_button where the device lacks that hardware. Android-only system actions: lock, power_dialog, quick_settings, screenshot, split_screen (raw system toggle; windowMode places a chosen app) and dismiss_notification_shade; each needs the API level and CtrlProxy APK that supports it and otherwise returns unsupported_system_action. Android Automotive only: rotary_rotate_cw / rotary_rotate_ccw (steps detents), rotary_nudge_up/down/left/right and rotary_select drive a rotary controller; other devices refuse them. lock leaves the device locked (wakeAndUnlock); power_dialog and quick_settings stay open until back/home.",
  input: pressButtonInput,
  options: {
    outputSchema: pressButtonResultSchema,
    defaultEnabled: true,
    supportsProgress: true,
    ...NAV_PLAN_SKELETON,
  },
});

export const pressButtonSchema = pressButtonTool.schema;

export const wakeAndUnlockTool = defineDeviceTool({
  name: "wakeAndUnlock",
  description:
    "Wake a device and unlock its keyguard. Android: swipe lock or secure PIN via `pin`; iOS: wake + swipe-dismiss (pin ignored).",
  input: wakeAndUnlockInput,
  options: { ...PLAN_RELEVANT, outputSchema: wakeAndUnlockResultSchema, defaultEnabled: true },
});

export const wakeAndUnlockSchema = wakeAndUnlockTool.schema;

export const recentAppsTool = defineDeviceTool({
  name: "recentApps",
  description: "Open recent apps",
  input: recentAppsInput,
  options: {
    defaultEnabled: true,
    supportsProgress: true,
    outputSchema: recentAppsResultSchema,
    ...PLAN_SKELETON,
  },
});

export const recentAppsSchema = recentAppsTool.schema;

const homeScreenTool = defineDeviceTool({
  name: "homeScreen",
  description: "Go to home screen",
  input: homeScreenInput,
  options: {
    defaultEnabled: true,
    supportsProgress: true,
    outputSchema: homeScreenResultSchema,
    ...PLAN_SKELETON,
  },
});

export const homeScreenSchema = homeScreenTool.schema;

export const selectAllTextTool = defineDeviceTool({
  name: "selectAllText",
  description: "Select all text in focused input",
  input: selectAllTextInput,
  options: {
    defaultEnabled: false,
    supportsProgress: true,
    outputSchema: selectAllTextResultSchema,
    ...PLAN_SKELETON,
  },
});

export const selectAllTextSchema = selectAllTextTool.schema;

export const shakeTool = defineDeviceTool({
  name: "shake",
  description:
    "Shake device; iOS Simulator and Android emulator only (unsupported on physical iOS and Android devices).",
  input: shakeInput,
  options: {
    defaultEnabled: false,
    supportsProgress: true,
    outputSchema: shakeResultSchema,
    ...PLAN_SKELETON,
  },
});

export const shakeSchema = shakeTool.schema;

export const rotateTool = defineDeviceTool({
  name: "rotate",
  description: "Rotate device orientation",
  input: rotateInput,
  options: {
    defaultEnabled: false,
    supportsProgress: true,
    outputSchema: rotateResultSchema,
    ...PLAN_SKELETON,
  },
});

export const rotateSchema = rotateTool.schema;

export const keyboardTool = defineDeviceTool({
  name: "keyboard",
  description:
    "Open, close, detect, list/select installed Android IMEs, or switch the AutoMobile typing profile",
  input: keyboardInput,
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: true,
    outputSchema: keyboardResultSchema,
    // detect, listImes and listProfiles change no UI: reads (#10965). The rest are control.
    deviceReadOnly: (args) => KEYBOARD_READ_ACTIONS.has(args.action),
    deviceReadOnlyArgs: [{ argument: "action", values: [...KEYBOARD_READ_ACTIONS] }],
  },
});

export const keyboardSchema = keyboardTool.schema;

/** Register the element gesture tools (tapAny, dragAndDrop, swipeOn, pinchOn), in that order. */
function registerGestureTools(deps: InteractionToolDependencies): void {
  ToolRegistry.registerDeviceAware(
    "tapAny",
    "Tap any clickable element; scope with container or scrollableContainer.",
    tapAnySchema,
    {
      handler: (device, args, progress, signal) =>
        tapAnyHandler(device, args, { progress, signal, deps }),
      defaultEnabled: true,
      supportsProgress: true,
      ...PLAN_SKELETON,
      ...ANSWERS_SYSTEM_ALERTS,
    },
  );

  ToolRegistry.registerDeviceAware("dragAndDrop", "Drag and drop element", dragAndDropSchema, {
    handler: (device, args, progress, signal) =>
      dragAndDropHandler(device, args, { progress, signal, deps }),
    defaultEnabled: false,
    supportsProgress: true,
    outputSchema: dragAndDropResultSchema,
    ...NAV_PLAN_SKELETON,
  });

  ToolRegistry.registerDeviceAware("swipeOn", "Swipe/scroll on screen or elements", swipeOnSchema, {
    handler: (device, args, progress, signal) =>
      swipeOnHandler(device, args, { progress, signal, deps }),
    defaultEnabled: true,
    supportsProgress: true,
    ...NAV_PLAN_SKELETON,
  });

  ToolRegistry.registerDeviceAware("pinchOn", "Pinch to zoom", pinchOnSchema, {
    handler: (device, args, progress, signal) =>
      pinchOnHandler(device, args, { progress, signal, deps }),
    defaultEnabled: false,
    supportsProgress: true,
    outputSchema: pinchOnResultSchema,
    ...NAV_PLAN_SKELETON,
  });
}

export function registerInteractionTools(deps: InteractionToolDependencies = {}) {
  // tapOn, tapAny, dragAndDrop, selectAllText, pressButton, and swipeOn handlers
  // are defined at module scope (each with an
  // injectable factory) so a unit test can exercise the registered handler
  // wiring (#6152, #6163).

  // System tray handler: domain logic lives in features/systemTray/SystemTray.

  // swipeOn handler is defined at module scope (with an injectable SwipeOn
  // factory) so a unit test can exercise the registered handler wiring (#6163).

  // Pinch on handler
  // pinchOn handler is defined at module scope (with an injectable PinchOn
  // factory) so a unit test can exercise the registered handler wiring (#6056).

  // Wake and unlock handler

  // Open link handler

  // Shake handler

  // Keyboard handler

  // Recent Apps handler

  // Home Screen handler

  // Clipboard handler

  // Register with the tool registry
  selectAllTextTool.register(ToolRegistry, (device, args, progress, signal) =>
    selectAllTextHandler(device, args, { progress, signal, deps }),
  );

  pressButtonTool.register(ToolRegistry, (device, args, progress, signal) =>
    pressButtonHandler(device, args, { progress, signal, deps }),
  );

  ToolRegistry.registerDeviceAware(
    "systemTray",
    "System tray actions for notifications (open/close/list/find/tap/dismiss/clearAll)",
    systemTraySchema,
    {
      handler: systemTrayHandler,
      defaultEnabled: false,
      supportsProgress: true,
      outputSchema: systemTrayResultSchema,
      ...PLAN_SKELETON,
    },
  );

  ToolRegistry.registerDeviceAware(
    "sendKeys",
    "Execute ordered typing, clear, raw-key, and semantic IME commands. Unicode: iOS any mode; Android a11y/ime/auto/eventAll/eventLast (event modes use a11y for unsupported runs). Android eventOnly/imeKeyEvents are ASCII-only. textLength counts code points.",
    sendKeysSchema,
    {
      handler: createSendKeysHandler(deps),
      defaultEnabled: true,
      supportsProgress: true,
      outputSchema: sendKeysResultSchema,
      ...NAV_PLAN_SKELETON,
    },
  );

  wakeAndUnlockTool.register(ToolRegistry, createWakeAndUnlockHandler(deps));

  ToolRegistry.registerDeviceAware(
    "openLink",
    'Open URL in browser. A transient Android ADB failure returns device_transport_unavailable (retryable: true, retryAfterMs, deviceId). dispatched is false before dispatch or "unknown" after transport loss (true is reserved for confirmed dispatch). For "unknown", the link may already have opened: observe before reissuing a single-use link.',
    openLinkSchema,
    {
      handler: createOpenLinkHandler(deps),
      defaultEnabled: false,
      outputSchema: openLinkResultSchema,
      ...PLAN_SKELETON,
    },
  );

  ToolRegistry.registerDeviceAware(
    "tapOn",
    "Tap an element by text/content-desc, resource-id, or Android test tag; use sibling for adjacent controls.",
    tapOnSchema,
    {
      handler: (device, args, progress, signal) =>
        tapOnHandler(device, args, { progress, signal, deps }),
      defaultEnabled: true,
      supportsProgress: true,
      outputSchema: tapOnResultSchema,
      ...NAV_PLAN_SKELETON,
    },
  );

  ToolRegistry.registerDeviceAware(
    "tapAt",
    "Tap, long press, or double tap at screen coordinates in native, normalized, or percent units.",
    tapAtSchema,
    {
      handler: (device, args, progress, signal) =>
        tapAtHandler(device, args, { progress, signal, deps }),
      defaultEnabled: true,
      supportsProgress: true,
      ...PLAN_SKELETON,
      ...ANSWERS_SYSTEM_ALERTS,
    },
  );

  ToolRegistry.registerDeviceAware(
    "dragPath",
    "Drag a finger (or, with pointer, a stylus on Android 12+) along a polyline with segment timing, an initial hold and a release hold.",
    dragPathSchema,
    {
      handler: dragPathHandler,
      defaultEnabled: false,
      supportsProgress: true,
      ...PLAN_SKELETON,
      ...ANSWERS_SYSTEM_ALERTS,
    },
  );

  ToolRegistry.registerDeviceAware(
    "hoverAt",
    "Hover a stylus or mouse over a path with no contact: hover enter, move, exit (Android; needs hover_input_v1 or, for a stylus, a root adb shell with a writable /dev/uinput).",
    hoverAtSchema,
    {
      handler: hoverAtHandler,
      defaultEnabled: false,
      supportsProgress: true,
      ...PLAN_SKELETON,
      ...ANSWERS_SYSTEM_ALERTS,
    },
  );

  ToolRegistry.registerDeviceAware(
    "hitTest",
    "Preview hierarchy-bounds candidates at a platform-native screen point; no input is dispatched and the actual event recipient is unknown.",
    hitTestSchema,
    {
      handler: (device, args, progress, signal) =>
        hitTestHandler(device, args, { progress, signal, deps }),
      // Dispatches no input: a read (#10965). On a held device it reads through the observer
      // capture (`readHitTestObservation`), never the holder's session pipeline (#10828).
      defaultEnabled: false,
      deviceReadOnly: true,
    },
  );

  registerGestureTools(deps);

  shakeTool.register(ToolRegistry, createShakeHandler(deps));

  keyboardTool.register(ToolRegistry, createKeyboardHandler(deps));

  recentAppsTool.register(ToolRegistry, createRecentAppsHandler(deps));

  homeScreenTool.register(ToolRegistry, homeScreenHandler);

  // Register the new rotate tool
  rotateTool.register(ToolRegistry, (device, args, progress, signal) =>
    rotateHandler(device, args, { progress, signal, deps }),
  );

  ToolRegistry.registerDeviceAware(
    "setPosture",
    "Set Android device posture or iPhone Duo simulator posture, with an optional Resizable Android display preset. Specify exactly one of posture or hingeAngle (finite degrees, 0-180 inclusive). Hinge angle is BEST EFFORT, emulator/simulator only, without displayPreset; unsupported returns status: unsupported with a reason and no state change. Android console support is detected at call time; iOS requires a runner advertising set_hinge_angle (#8547). Angle results echo hingeAngle and device posture read-back, or unknown with postureReason. Android strictly parses emu sensor get hinge-angle0 output as hinge-angle0 = <n>; iOS uses the runner angle. Both report observedHingeAngle when available and warn without failing when the resulting angle is unavailable or differs by more than 1 degree.",
    setPostureSchema,
    {
      handler: (device, args, progress, signal) =>
        setPostureHandler(device, args, { progress, signal, deps }),
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: setPostureResultSchema,
    },
  );

  // Register the clipboard tool
  ToolRegistry.registerDeviceAware(
    "clipboard",
    "Clipboard operations (copy/paste/clear/get)",
    clipboardSchema,
    {
      handler: createClipboardHandler(deps),
      // get changes no UI: a read (#10965). copy, paste and clear are control.
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: clipboardResultSchema,
      deviceReadOnly: (args: ClipboardArgs) => args.action === "get",
      deviceReadOnlyArgs: [{ argument: "action", values: ["get"] }],
    },
  );
}
export {
  hitTestSchema,
  tapAnySchema,
  tapAtSchema,
  tapOnSchema,
} from "./interactionTools/tapSchemas";

export { dragAndDropSchema, pinchOnSchema, swipeOnSchema } from "./interactionTools/gestureSchemas";

export { clipboardSchema, sendKeysSchema } from "./interactionTools/inputSchemas";

export {
  clearStateSchema,
  openLinkSchema,
  setPostureSchema,
  stopAppSchema,
  systemTraySchema,
} from "./interactionTools/deviceSchemas";

export type {
  AcceptIosAppOpenAlertOptions,
  DragAndDropLike,
  InteractionToolDependencies,
  OpenAlertHierarchyRefresh,
  OpenAlertResolution,
  OpenLinkWaitOutcome,
  PinchOnLike,
  PressButtonLike,
  RotateLike,
  SelectAllTextLike,
  SendKeysRunnerCommandSource,
  SendKeysRunnerCommandSourceFactory,
  SetPostureLike,
  SwipeOnLike,
  SystemAlertTap,
  TapAnyElementLike,
  TapAtElementLike,
  TapOnElementLike,
} from "./interactionTools/dependencies";

export {
  dragAndDropHandler,
  formatPinchOnMessage,
  formatSwipeOnMessage,
  pinchOnHandler,
  swipeOnHandler,
} from "./interactionTools/gestureHandlers";

export {
  buildTapOnResultMessage,
  hitTestHandler,
  isIosAppOpenAlert,
  tapAnyHandler,
  tapAtHandler,
  tapOnHandler,
} from "./interactionTools/tapHandlers";

export {
  formatRotateMessage,
  formatSetPostureMessage,
  pressButtonHandler,
  rotateHandler,
  selectAllTextHandler,
  setPostureHandler,
} from "./interactionTools/deviceHandlers";
