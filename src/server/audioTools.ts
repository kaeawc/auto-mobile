import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import {
  captureAudioResultSchema,
  injectAudioInputResultSchema,
  stopAudioInputResultSchema,
} from "./audioToolOutputSchemas";
import { runSessionSensorMutation, type SessionSensorHost } from "./sessionSensor";
import { safeFilenameSegment } from "./toolOutputArtifactLedger";
import { defaultDaemonContext } from "../daemon/daemonContext";
import type { SessionManager } from "../daemon/sessionManager";
import type { AudioSource, EmulatorAudioService } from "../features/audio/EmulatorAudioService";
import { defaultEmulatorAudioService } from "../features/audio/defaultEmulatorAudioService";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { encodeWav, DEFAULT_SILENCE_THRESHOLD_DBFS } from "../utils/audio/pcm";
import { serverConfig } from "../utils/ServerConfig";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getDefaultToolOutputsDir } from "../utils/toolOutputArtifacts";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { errorMessage } from "../models/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

/** Capture stays well under the daemon's 30 s default request timeout, including its 2 s grace. */
export const MAX_CAPTURE_SECONDS = 20;

const injectAudioInputInput = z.object({
  file: z
    .string()
    .min(1)
    .optional()
    .describe("Host path to an uncompressed PCM WAV file. Pass file or tone, not both."),
  tone: z
    .object({
      frequencyHz: z.number().min(20).max(20_000).optional().describe("Default 1000."),
      durationMs: z.number().int().min(100).max(600_000).optional().describe("Default 2000."),
    })
    .strict()
    .optional()
    .describe("Built-in sine tone at -6 dBFS, for a known non-silent signal without a file."),
  loop: z.boolean().optional().describe("Repeat until stopped or maxDurationMs (default 10 min)."),
  startDelayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Wait before the first audio, so the app can start recording."),
  gainDb: z.number().min(-60).max(20).optional().describe("Gain applied before injection."),
  maxDurationMs: z.number().int().min(100).max(3_600_000).optional(),
});

const stopAudioInputInput = z.object({
  injectionId: z.string().min(1).describe("The id injectAudioInput returned."),
});

const captureAudioInput = z.object({
  seconds: z
    .number()
    .min(0.1)
    .max(MAX_CAPTURE_SECONDS)
    .describe("How long to record the emulator's audio output."),
  silenceThresholdDbfs: z
    .number()
    .min(-120)
    .max(0)
    .optional()
    .describe(
      `A 20 ms window at or above this level counts as sound. Default ${DEFAULT_SILENCE_THRESHOLD_DBFS}.`,
    ),
  saveArtifact: z.boolean().optional().describe("Write the capture to a WAV file on the host."),
});

/** The session admission a start needs, plus a non-expiring read for the post-start check. */
export type AudioSessionHost = SessionSensorHost & Pick<SessionManager, "findSession">;

export interface AudioToolDependencies {
  service?: Pick<EmulatorAudioService, "startInjection" | "stopInjection" | "capture">;
  sessionManager?: () => AudioSessionHost | undefined;
  saveWav?: (deviceId: string, bytes: Uint8Array) => Promise<string>;
}

function assertAndroid(device: BootedDevice, tool: string): void {
  if (device.platform !== "android") {
    throw new ActionableError(
      `${tool} supports Android emulators only; iOS Simulator audio is not supported yet.`,
    );
  }
}

function sourceFrom(args: {
  file?: string;
  tone?: { frequencyHz?: number; durationMs?: number };
}): AudioSource {
  if (args.file && args.tone) {
    throw new ActionableError("Pass either file or tone to injectAudioInput, not both.");
  }
  // The daemon runs from the home directory; a relative path means the launch directory.
  return args.file
    ? { kind: "file", path: resolvePathFromDaemonLaunchWorkingDirectory(args.file) }
    : { kind: "tone", ...args.tone };
}

/** Writes beside the other tool outputs; binary files are returned by host path, never inlined. */
export function createToolOutputsWavSaver(
  timer: Pick<Timer, "now"> = defaultTimer,
  directory: () => string = () => serverConfig.getToolOutputsDir() ?? getDefaultToolOutputsDir(),
  ids: IdGenerator = defaultIdGenerator,
): (deviceId: string, bytes: Uint8Array) => Promise<string> {
  return async (deviceId, bytes) => {
    const dir = directory();
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      // The id keeps two captures saved in the same millisecond from overwriting each other.
      `${Math.trunc(timer.now())}-captureAudio-${safeFilenameSegment(deviceId)}-${safeFilenameSegment(ids.next())}.wav`,
    );
    await writeFile(file, bytes);
    return file;
  };
}

/**
 * Why a just-started injection must not keep playing, or undefined when it may. The call can be
 * aborted while the start connects (a session acquiring the device cancels sessionless calls, and
 * acquisition cleanup found nothing to stop yet), and a release can commit after its setup drain
 * times out (its cleanup likewise found nothing). Checked once the injection exists.
 */
function startOutlivedBy(
  sessionManager: AudioSessionHost | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  signal: AbortSignal | undefined,
): string | undefined {
  if (signal?.aborted) {
    return "The call was cancelled while the audio injection was starting";
  }
  if (!sessionManager || !sessionUuid) {
    return undefined;
  }
  const session = sessionManager.findSession(sessionUuid);
  const holds =
    session &&
    sessionManager.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId;
  return holds ? undefined : "The session was released while the audio injection was starting";
}

async function stopAndRefuse(
  reason: string,
  started: { injectionId: string },
  service: Pick<EmulatorAudioService, "stopInjection">,
): Promise<never> {
  await service.stopInjection(started.injectionId).catch((error: unknown) => {
    // The injection is ended either way; the refusal below is what the caller needs.
    logger.warn(`Failed to stop audio injection ${started.injectionId}: ${errorMessage(error)}`);
  });
  throw new ActionableError(`${reason}; the injection was stopped.`);
}

export const createInjectAudioInputHandler =
  (deps: AudioToolDependencies = {}): DeviceToolHandler<typeof injectAudioInputInput> =>
  async (device, args, _progress, signal) => {
    assertAndroid(device, "injectAudioInput");
    const source = sourceFrom(args);
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const service = deps.service ?? defaultEmulatorAudioService;
    const started = await runSessionSensorMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      (owner) =>
        service.startInjection(device.deviceId, {
          source,
          loop: args.loop,
          startDelayMs: args.startDelayMs,
          gainDb: args.gainDb,
          maxDurationMs: args.maxDurationMs,
          sessionId: owner,
        }),
      { action: "inject emulator audio", change: "audio injection" },
    );
    const outlived = startOutlivedBy(sessionManager, args.sessionUuid, device.deviceId, signal);
    if (outlived) {
      await stopAndRefuse(outlived, started, service);
    }
    return createStructuredToolResponse({
      success: true,
      message:
        `Injecting ${started.durationMs} ms of audio into ${device.deviceId}'s microphone` +
        `${args.loop ? " on a loop" : ""}. Stop it with stopAudioInput.`,
      ...started,
    });
  };

export const createStopAudioInputHandler =
  (deps: AudioToolDependencies = {}): DeviceToolHandler<typeof stopAudioInputInput> =>
  async (device, args) => {
    const service = deps.service ?? defaultEmulatorAudioService;
    const stopped = await service.stopInjection(args.injectionId, device.deviceId);
    return createStructuredToolResponse({
      success: true,
      message: `Audio injection ${stopped.injectionId} ended (${stopped.reason}) after ${stopped.framesQueued} frames queued (about ${stopped.framesPlayed} played).`,
      ...stopped,
    });
  };

export const createCaptureAudioHandler =
  (deps: AudioToolDependencies = {}): DeviceToolHandler<typeof captureAudioInput> =>
  async (device, args) => {
    assertAndroid(device, "captureAudio");
    const service = deps.service ?? defaultEmulatorAudioService;
    const { pcm, ...levels } = await service.capture(device.deviceId, {
      durationMs: Math.round(args.seconds * 1000),
      silenceThresholdDbfs: args.silenceThresholdDbfs,
    });
    let artifact: { path: string; sizeBytes: number } | undefined;
    if (args.saveArtifact) {
      const bytes = encodeWav(pcm);
      artifact = {
        path: await (deps.saveWav ?? createToolOutputsWavSaver())(device.deviceId, bytes),
        sizeBytes: bytes.byteLength,
      };
    }
    return createStructuredToolResponse({
      success: true,
      message: levels.silent
        ? `No audio above the threshold in ${levels.durationMs} ms from ${device.deviceId}.`
        : `Captured ${levels.durationMs} ms of audio from ${device.deviceId} (peak ${levels.peakDbfs} dBFS).`,
      deviceId: device.deviceId,
      ...levels,
      ...artifact,
    });
  };

const injectAudioInputTool = defineDeviceTool({
  name: "injectAudioInput",
  description:
    "Play a WAV file or a built-in tone into an Android emulator's microphone, so an app under test " +
    "records known audio (voice notes, voice search, calls). Streams through the emulator's own gRPC " +
    "audio API, so each emulator is isolated and no host audio device is needed. Returns an " +
    "injectionId once streaming starts; stop it with stopAudioInput. Session release stops it. " +
    "Errors lead with a code: [audio_injection_busy] another injection holds this emulator's " +
    "microphone; [audio_injection_unsupported] the device is not a local emulator with gRPC audio. " +
    "Physical devices and iOS are refused.",
  input: injectAudioInputInput,
  options: {
    defaultEnabled: false,
    // gRPC only: no CtrlProxy or runner setup.
    deviceReadiness: "booted",
    outputSchema: injectAudioInputResultSchema,
  },
});

const stopAudioInputTool = defineDeviceTool({
  name: "stopAudioInput",
  description:
    "Stop an audio injection started by injectAudioInput, on the device it runs on. Idempotent: an " +
    "injection that already ended returns its result (frames sent and why it ended); the last 64 " +
    "ended injections are kept.",
  input: stopAudioInputInput,
  options: {
    defaultEnabled: false,
    // gRPC only: no CtrlProxy or runner setup.
    deviceReadiness: "booted",
    outputSchema: stopAudioInputResultSchema,
  },
});

const captureAudioTool = defineDeviceTool({
  name: "captureAudio",
  description:
    `Record up to ${MAX_CAPTURE_SECONDS} s of an Android emulator's audio output and report its level: ` +
    "rmsDbfs, peakDbfs, the share of 20 ms windows with sound (activeRatio), and silent. A guest " +
    "that plays nothing returns silent: true rather than an error. saveArtifact writes a WAV and " +
    "returns its host path. Assert loosely (silent or not, duration within a margin); loaded hosts " +
    "can glitch real-time audio. Physical devices and iOS are refused.",
  input: captureAudioInput,
  options: {
    defaultEnabled: false,
    // gRPC only: no CtrlProxy or runner setup.
    deviceReadiness: "booted",
    deviceReadOnly: true,
    outputSchema: captureAudioResultSchema,
  },
});

export const injectAudioInputSchema = injectAudioInputTool.schema;
export const stopAudioInputSchema = stopAudioInputTool.schema;
export const captureAudioSchema = captureAudioTool.schema;

export function registerAudioTools(deps: AudioToolDependencies = {}): void {
  injectAudioInputTool.register(undefined, createInjectAudioInputHandler(deps));
  stopAudioInputTool.register(undefined, createStopAudioInputHandler(deps));
  captureAudioTool.register(undefined, createCaptureAudioHandler(deps));
}
