import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool } from "./defineTool";
import { mediaSessionResultSchema } from "./mediaSessionToolOutputSchemas";
import { ActionableError, type BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../utils/SystemTimer";
import {
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  MAX_WAIT_FOR_TIMEOUT_MS,
} from "../features/observe/waitForTimeout";
import {
  AndroidMediaSessionController,
  type MediaSessionController,
} from "../features/media/MediaSessionController";
import {
  MEDIA_DISPATCH_KEYS,
  MEDIA_PLAYBACK_STATES,
  MEDIA_VOLUME_STREAMS,
  type MediaSessionDump,
} from "../features/media/MediaSessionTypes";

const mediaSessionInput = z.object({
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Package. get: only its sessions. dispatch: refuse unless it is the media button session",
    ),
  action: z
    .union([
      z.literal("get"),
      z.object({ dispatch: z.enum(MEDIA_DISPATCH_KEYS) }).strict(),
      z
        .object({
          volume: z
            .object({
              stream: z.enum(MEDIA_VOLUME_STREAMS),
              level: z.number().int().min(0).describe("Volume index within the stream's range"),
            })
            .strict(),
        })
        .strict(),
    ])
    .describe(
      '"get" reads sessions; {dispatch} sends a media key like a headset; {volume} sets a stream index',
    ),
  waitFor: z
    .object({
      mediaState: z.enum(MEDIA_PLAYBACK_STATES).exclude(["unknown"]),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_WAIT_FOR_TIMEOUT_MS)
        .optional()
        .describe(`Wait timeout ms (default: ${DEFAULT_WAIT_FOR_TIMEOUT_MS})`),
    })
    .strict()
    .optional()
    .describe("get only: poll until a session (of appId, if given) reports this state"),
});

type MediaSessionArgs = z.output<typeof mediaSessionInput>;

/** Builds the controller a call drives; injectable so tests substitute a fake. */
export type MediaSessionControllerFactory = (device: BootedDevice) => MediaSessionController;

const defaultMediaSessionControllerFactory: MediaSessionControllerFactory = (device) =>
  new AndroidMediaSessionController(defaultAdbClientFactory.create(device), defaultTimer);

function sessionsPayload(dump: MediaSessionDump) {
  return { sessions: dump.sessions, mediaButtonSession: dump.mediaButtonSession };
}

function describeSessions(dump: MediaSessionDump): string {
  if (dump.sessions.length === 0) {
    return "No media sessions";
  }
  return dump.sessions
    .map((session) => {
      const title = session.metadata?.title ? ` "${session.metadata.title}"` : "";
      const button = session.isMediaButtonSession ? " [media button]" : "";
      return `${session.package}/${session.tag}: ${session.state}${title}${button}`;
    })
    .join("; ");
}

async function getAction(
  controller: MediaSessionController,
  args: MediaSessionArgs,
  signal: AbortSignal | undefined,
) {
  if (!args.waitFor) {
    const dump = await controller.getSessions({ appId: args.appId, signal });
    return {
      success: true,
      message: describeSessions(dump),
      action: "get",
      ...sessionsPayload(dump),
    };
  }
  const timeoutMs = args.waitFor.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
  const wait = await controller.waitForState({
    appId: args.appId,
    mediaState: args.waitFor.mediaState,
    timeoutMs,
    signal,
  });
  const scope = args.appId ? `${args.appId} session` : "media session";
  return {
    success: true,
    message: wait.matched
      ? `A ${scope} reported ${wait.mediaState} after ${wait.waitMs}ms`
      : `No ${scope} reported ${wait.mediaState} within ${timeoutMs}ms: ${describeSessions(wait.dump)}`,
    action: "get",
    ...sessionsPayload(wait.dump),
    wait: {
      mediaState: wait.mediaState,
      matched: wait.matched,
      waitMs: wait.waitMs,
      polls: wait.polls,
    },
    // The plan executor fails a step whose result reports awaitTimeout (waitForTimeoutError).
    ...(wait.matched ? {} : { awaitTimeout: true, awaitDuration: wait.waitMs }),
  };
}

async function dispatchAction(
  controller: MediaSessionController,
  args: MediaSessionArgs,
  key: (typeof MEDIA_DISPATCH_KEYS)[number],
  signal: AbortSignal | undefined,
) {
  const result = await controller.dispatch({ appId: args.appId, key, signal });
  const handler = result.handledBy
    ? `${result.handledBy.package}/${result.handledBy.tag}`
    : "no media session";
  const transition = result.stateChanged
    ? `${result.previousState} -> ${result.state}`
    : `state ${result.state ?? "unknown"} (unchanged)`;
  return {
    success: true,
    message: `Dispatched ${key} to ${handler}: ${transition}`,
    action: "dispatch",
    dispatch: {
      key: result.key,
      handledBy: result.handledBy,
      ...(result.previousState ? { previousState: result.previousState } : {}),
      ...(result.state ? { state: result.state } : {}),
      stateChanged: result.stateChanged,
    },
    ...(result.restore ? { restore: result.restore } : {}),
    ...sessionsPayload(result.dump),
  };
}

async function volumeAction(
  controller: MediaSessionController,
  volume: { stream: (typeof MEDIA_VOLUME_STREAMS)[number]; level: number },
  signal: AbortSignal | undefined,
) {
  const result = await controller.setVolume({ ...volume, signal });
  const { restore, ...applied } = result;
  return {
    success: result.verified,
    message: result.verified
      ? `${result.stream} volume ${result.previousLevel} -> ${result.level} (range ${result.min}..${result.max})`
      : `${result.stream} volume read back ${result.level} after requesting ${result.requestedLevel}`,
    action: "volume",
    volume: applied,
    restore,
  };
}

export const createMediaSessionHandler =
  (makeController: MediaSessionControllerFactory = defaultMediaSessionControllerFactory) =>
  async (
    device: BootedDevice,
    args: MediaSessionArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "mediaSession is Android-only: it reads dumpsys media_session and drives cmd media_session.",
      );
    }
    if (args.waitFor && args.action !== "get") {
      throw new ActionableError('waitFor is only valid with action "get".');
    }
    const controller = makeController(device);
    const action = args.action;
    if (action === "get") {
      return createStructuredToolResponse(await getAction(controller, args, signal));
    }
    if ("dispatch" in action) {
      return createStructuredToolResponse(
        await dispatchAction(controller, args, action.dispatch, signal),
      );
    }
    return createStructuredToolResponse(await volumeAction(controller, action.volume, signal));
  };

const mediaSessionTool = defineDeviceTool({
  name: "mediaSession",
  description:
    "Android media sessions: read playback state, position, speed, metadata and actions (dumpsys media_session); dispatch a transport key to the media button session like a headset, reporting which session handled it; or set a music/ring/alarm stream volume. Mutations return a restore receipt. waitFor polls get until a session reports a state.",
  input: mediaSessionInput,
  handler: createMediaSessionHandler(),
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    // Every action is plain adb (dumpsys / cmd media_session): no CtrlProxy or runner setup.
    deviceReadiness: "booted",
    outputSchema: mediaSessionResultSchema,
    // get changes nothing on the device: a read (#10965). dispatch and volume are control.
    deviceReadOnly: (args: { action?: unknown }) => args.action === "get",
    deviceReadOnlyArgs: [{ argument: "action", values: ["get"] }],
  },
});

export const mediaSessionSchema = mediaSessionTool.schema;

export function registerMediaSessionTools() {
  mediaSessionTool.register();
}
