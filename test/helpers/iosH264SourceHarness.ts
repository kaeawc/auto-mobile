import { EventEmitter } from "node:events";
import { type BootedDevice } from "../../src/models";
import { IosH264Source, type IosFrameCaptureHelper } from "../../src/features/webrtc/IosH264Source";
import { ENCODED_VIDEO_CAPABILITY } from "../../src/features/screen-stream";
import type { CaptureTarget, DecodedEncodedVideo } from "../../src/features/screen-stream";
export const IOS_DEVICE: BootedDevice = {
  deviceId: "00008140-001A2B3C0AE2401E",
  platform: "ios",
  name: "Jason's iPhone",
} as BootedDevice;

export const IOS_SIMULATOR: BootedDevice = {
  deviceId: "4DA8AF35-C59B-43D3-A8FE-5640A7B0B8C1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;

export const FAKE_HELPER_PATH = "/fake/screen-capture-helper";

export const fakeHelperPathExists = (candidate: string): boolean => candidate === FAKE_HELPER_PATH;

export class FakeFrameCaptureHelper extends EventEmitter implements IosFrameCaptureHelper {
  invalidate?: () => Promise<void>;
  started = false;
  stopped = false;
  isRunning = false;
  stopError: Error | null = null;
  keyFrameRequests = 0;
  keyFrameRequestResult = true;

  constructor(private readonly advertiseEncoded = true) {
    super();
  }

  start(): void {
    if (this.advertiseEncoded) {
      this.emitCapability(ENCODED_VIDEO_CAPABILITY);
    }
    this.started = true;
    this.isRunning = true;
  }

  async stop(): Promise<null> {
    this.stopped = true;
    this.isRunning = false;
    if (this.stopError) {
      throw this.stopError;
    }
    return null;
  }

  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return this.keyFrameRequestResult;
  }

  emitEncodedVideo(video: DecodedEncodedVideo): void {
    this.emit("encodedVideo", video);
  }

  emitCapability(token: string): void {
    this.emit("capability", token);
  }

  emitPermission(permission: string): void {
    this.emit("permission", permission);
  }

  emitMalformed(reason: string): void {
    this.emit("malformed", {
      reason,
      header: { width: 0, height: 0, bytesPerRow: 0, timestampMs: 0 },
    });
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", { code, signal });
  }

  emitStderr(line: string): void {
    this.emit("stderr", line);
  }

  emitReadiness(phase: string, atMs = 0, detail?: string): void {
    this.emit("readiness", { phase, atMs, detail });
  }
}

export function encodedRecord(
  payload: number[],
  keyframe = true,
  presentationTimestampMs = 1,
): DecodedEncodedVideo {
  return { keyframe, presentationTimestampMs, payload: Buffer.from(payload) };
}

export class DelayedStopFrameCaptureHelper extends FakeFrameCaptureHelper {
  private resolveStop: (() => void) | null = null;

  stopFinished = false;

  override async stop(): Promise<null> {
    this.stopped = true;
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    this.stopFinished = true;
    return null;
  }

  finishStop(): void {
    this.resolveStop?.();
  }
}

export class NeverStoppingFrameCaptureHelper extends FakeFrameCaptureHelper {
  override async stop(): Promise<null> {
    this.stopped = true;
    return new Promise<null>(() => {});
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function startWithRecord(
  source: IosH264Source,
  helper: FakeFrameCaptureHelper,
  firstRecord: DecodedEncodedVideo,
): Promise<void> {
  const started = source.start();
  await flush();
  helper.emitEncodedVideo(firstRecord);
  await started;
}

export function createHarness(
  device: BootedDevice = IOS_DEVICE,
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helper = new FakeFrameCaptureHelper();
  const helperTargets: CaptureTarget[] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];

  const source = new IosH264Source({
    device,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    createHelper: (options) => {
      helperTargets.push(options.target);
      return helper;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,

    ...overrides,
  });

  return { source, helper, helperTargets, chunks, errors };
}

export function createReconnectHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helpers: FakeFrameCaptureHelper[] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_DEVICE,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    createHelper: () => {
      const helper = new FakeFrameCaptureHelper();
      helpers.push(helper);
      return helper;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,

    ...overrides,
  });
  return { source, helpers, chunks, errors };
}

export function createResolverHarness(
  deviceName: string,
  windows: Array<{ windowID: number; title: string }>,
) {
  const helper = new FakeFrameCaptureHelper();
  const helperTargets: CaptureTarget[] = [];
  const source = new IosH264Source({
    device: { ...IOS_SIMULATOR, name: deviceName } as BootedDevice,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: () => {},
    createHelper: (options) => {
      helperTargets.push(options.target);
      return helper;
    },

    commandRunner: async (command, args) => {
      if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
        return {
          stdout: JSON.stringify({
            windows: windows.map((window) => ({
              ...window,
              applicationName: "Simulator",
              bundleIdentifier: "com.apple.iphonesimulator",
            })),
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
        };
      }
      return successfulCommandRunner(command, args);
    },
  });
  return { source, helper, helperTargets };
}

export async function successfulCommandRunner(_command: string, _args: string[]) {
  return { stdout: "", stderr: "", exitCode: 0, signal: null };
}

export function createEncodedHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helpers: FakeFrameCaptureHelper[] = [];
  const helperTargets: CaptureTarget[] = [];
  const commandRunnerCalls: string[][] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_SIMULATOR,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),

    createHelper: (options) => {
      helperTargets.push(options.target);
      const helper = new FakeFrameCaptureHelper(false);
      helpers.push(helper);
      return helper;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: async (command, args) => {
      commandRunnerCalls.push(args);
      return successfulCommandRunner(command, args);
    },
    ...overrides,
  });
  return { source, helpers, helperTargets, commandRunnerCalls, chunks, errors };
}

export async function startEncoded(
  source: IosH264Source,
  helpers: FakeFrameCaptureHelper[],
  firstRecord: DecodedEncodedVideo = encodedRecord([0, 0, 0, 1, 0x65, 0x88]),
): Promise<void> {
  const started = source.start();
  await flush();
  helpers[0].emitCapability(ENCODED_VIDEO_CAPABILITY);
  helpers[0].emitEncodedVideo(firstRecord);
  await started;
}
