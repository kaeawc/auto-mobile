import os from "node:os";
import { existingDesktopHeadUnitConsole } from "../../features/androidAuto/AndroidAutoProjectionService";
import {
  HEAD_UNIT_DISPLAY,
  HeadUnitInteraction,
  headUnitButtonCommands,
  headUnitTapCommand,
  type HeadUnitInteractionResult,
} from "../../features/androidAuto/HeadUnitInteraction";
import { defaultHeadUnitFence } from "../../features/androidAuto/HeadUnitFence";
import { DhuScreenshotHashSource } from "../../features/androidAuto/HeadUnitScreenshotHash";
import { ActionableError, type BootedDevice } from "../../models";
import { DefaultFileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { defaultTimer } from "../../utils/SystemTimer";
import { createStructuredToolResponse } from "../../utils/toolUtils";
import type { PressButtonArgs, TapAtArgs } from "../interactionToolTypes";
import { carAppTemplateReader } from "../observeResponse";

/** What a head-unit action needs: send console commands and read the projected templates. */
export interface HeadUnitInteractionLike {
  run(commands: readonly string[], signal?: AbortSignal): Promise<HeadUnitInteractionResult>;
}

export type HeadUnitInteractionFactory = (device: BootedDevice) => HeadUnitInteractionLike;

/**
 * Uses the DHU this daemon already runs for the device, and never starts one: an action that finds
 * none fails and says how to start it.
 */
export const defaultHeadUnitInteractionFactory: HeadUnitInteractionFactory = (device) => {
  const dhuConsole = existingDesktopHeadUnitConsole(device.deviceId);
  if (!dhuConsole) {
    throw new ActionableError(
      `No Desktop Head Unit is running for ${device.deviceId} in this AutoMobile daemon, so display "${HEAD_UNIT_DISPLAY}" has no target. Start one with startDevice androidAuto.headUnit (or provisionDevice androidAuto), then retry.`,
    );
  }
  return new HeadUnitInteraction(
    dhuConsole,
    { read: () => carAppTemplateReader().readProjected(device) },
    defaultTimer,
    {
      fence: { deviceId: device.deviceId, state: defaultHeadUnitFence },
      screenshots: new DhuScreenshotHashSource(dhuConsole, {
        files: new DefaultFileSystem(),
        timer: defaultTimer,
        ids: defaultIdGenerator,
        directory: os.tmpdir(),
      }),
    },
  );
};

function assertAndroid(device: BootedDevice, tool: string): void {
  if (device.platform !== "android") {
    throw new ActionableError(
      `${tool} display "${HEAD_UNIT_DISPLAY}" is for an Android phone projecting through Android Auto, not ${device.platform}.`,
    );
  }
}

function effectSummary(result: HeadUnitInteractionResult): string {
  // The screen that moved; with several projected apps the unchanged ones are not the news.
  const top = result.after?.find(
    (screen) =>
      !result.before?.some(
        (prior) =>
          prior.packageName === screen.packageName &&
          prior.carSessionId === screen.carSessionId &&
          prior.screenClass === screen.screenClass &&
          prior.depth === screen.depth,
      ),
  );
  if (result.effect.screenChanged === true) {
    return `; screen changed${top ? ` (${top.screenClass.split(".").at(-1)} on top)` : ""}`;
  }
  if (result.effect.screenChanged === false) {
    return "; screen unchanged";
  }
  return "; no projected template data, so the change is unknown";
}

/** tapAt fields with no DHU console equivalent, and whether a call set them. */
const UNSUPPORTED_TAP_AT_FIELDS: readonly [string, (args: TapAtArgs) => boolean][] = [
  ["image", (args) => args.image !== undefined],
  [
    "coordinateSpace",
    (args) => args.coordinateSpace !== undefined && args.coordinateSpace !== "absolute",
  ],
  ["action", (args) => args.action !== undefined && args.action !== "tap"],
  ["durationMs", (args) => args.durationMs !== undefined],
  ["snapshotId", (args) => args.snapshotId !== undefined],
  ["pointer", (args) => args.pointer !== undefined],
  ["layer", (args) => args.layer !== undefined],
];

/** Head-unit tapAt fields; everything phone-specific is refused rather than ignored. */
function tapAtCommand(args: TapAtArgs): string {
  const unsupported = UNSUPPORTED_TAP_AT_FIELDS.flatMap(([field, isSet]) =>
    isSet(args) ? [field] : [],
  );
  if (unsupported.length > 0) {
    throw new ActionableError(
      `tapAt display "${HEAD_UNIT_DISPLAY}" takes x and y in head-unit pixels and a plain tap; ${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported there.`,
    );
  }
  if (args.x === undefined || args.y === undefined) {
    throw new ActionableError(`tapAt display "${HEAD_UNIT_DISPLAY}" requires x and y.`);
  }
  return headUnitTapCommand(args.x, args.y);
}

export async function headUnitTapAtHandler(
  device: BootedDevice,
  args: TapAtArgs,
  factory: HeadUnitInteractionFactory = defaultHeadUnitInteractionFactory,
  signal?: AbortSignal,
) {
  assertAndroid(device, "tapAt");
  const command = tapAtCommand(args);
  const result = await factory(device).run([command], signal);
  const x = Math.round(args.x ?? 0);
  const y = Math.round(args.y ?? 0);
  return createStructuredToolResponse({
    message: `Tapped the head unit at (${x}, ${y})${effectSummary(result)}`,
    success: true,
    action: "tap",
    x,
    y,
    headUnit: result,
    deviceId: device.deviceId,
    platform: device.platform,
  });
}

export async function headUnitPressButtonHandler(
  device: BootedDevice,
  args: PressButtonArgs,
  factory: HeadUnitInteractionFactory = defaultHeadUnitInteractionFactory,
  signal?: AbortSignal,
) {
  assertAndroid(device, "pressButton");
  const commands = headUnitButtonCommands(args.button, {
    steps: args.steps,
    durationMs: args.durationMs,
  });
  const result = await factory(device).run(commands, signal);
  return createStructuredToolResponse({
    message: `Pressed ${args.button} on the head unit${effectSummary(result)}`,
    success: true,
    button: args.button,
    headUnit: result,
  });
}
