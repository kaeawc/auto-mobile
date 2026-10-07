import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import type { DisplayPanel } from "../../models/DisplayPanel";
import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import {
  REQUIRED_SIMULATOR_COREDEVICE_VERSION,
  type CoreDeviceCapabilityResult,
} from "./CoreDeviceCapabilityProbe";
import { sharedCoreDeviceProbeHolder, type CoreDeviceProbeHolder } from "./CoreDeviceProbeHolder";
import { parseDevicectlDisplayInfo, type DevicectlDisplayInfo } from "./DevicectlDisplayInfo";

/** The probed command doubles as the capture-time display read (owner, #8350: never cached). */
export const DEVICECTL_DISPLAYS_COMMAND = "info displays";
/** Same bound as the simctl panel screenshot it replaces. */
export const DEVICECTL_SCREENSHOT_TIMEOUT_MS = 10_000;

/** xcrun is the command, not part of its arguments. */
export function buildDevicectlDisplayScreenshotArgs(options: {
  deviceId: string;
  destination: string;
  displayUniqueId?: string;
}): string[] {
  const { deviceId, destination, displayUniqueId } = options;
  if (!deviceId || deviceId.startsWith("-")) {
    throw new ActionableError(
      "Provide a non-empty device ID that does not start with '-' to capture a screenshot.",
    );
  }
  if (displayUniqueId !== undefined && (!displayUniqueId || displayUniqueId.startsWith("-"))) {
    throw new ActionableError(
      "Provide a non-empty display unique ID that does not start with '-', or omit it to capture the primary display.",
    );
  }
  if (!destination.toLowerCase().endsWith(".png")) {
    throw new ActionableError("Provide a screenshot destination ending in '.png'.");
  }
  return [
    "devicectl",
    "device",
    "capture",
    "screenshot",
    "--device",
    deviceId,
    "--destination",
    destination,
    ...(displayUniqueId ? ["--display-unique-id", displayUniqueId] : []),
  ];
}

/** Captures one display by its CoreDevice unique ID. */
export interface SimulatorDisplayScreenshotCapture {
  capture(options: {
    deviceId: string;
    displayUniqueId: string;
    signal?: AbortSignal;
  }): Promise<Buffer>;
}

/** Use only a supported command with a known unique ID for multi-display capture. */
export function chooseSimulatorPanelScreenshotTransport(input: {
  panelCount: number;
  panelKey: string;
  displayUniqueId: string | undefined;
  capability: CoreDeviceCapabilityResult;
}):
  | { kind: "devicectl"; displayUniqueId: string }
  | {
      kind: "simctl";
      display: string;
      reason: "single-display" | "no-unique-id" | "coredevice-unsupported";
    } {
  if (input.panelCount < 2) {
    return { kind: "simctl", display: input.panelKey, reason: "single-display" };
  }
  if (input.capability.kind !== "supported") {
    return { kind: "simctl", display: input.panelKey, reason: "coredevice-unsupported" };
  }
  if (!input.displayUniqueId) {
    return { kind: "simctl", display: input.panelKey, reason: "no-unique-id" };
  }
  return { kind: "devicectl", displayUniqueId: input.displayUniqueId };
}

function sameSize(
  size: { width: number; height: number } | undefined,
  panel: { width: number; height: number },
): boolean {
  return (
    size !== undefined &&
    ((size.width === panel.width && size.height === panel.height) ||
      (size.width === panel.height && size.height === panel.width))
  );
}

function onlyUniqueId(displays: readonly DevicectlDisplayInfo[]): string | undefined {
  return displays.length === 1 ? displays[0].uniqueId : undefined;
}

/**
 * Map a simctl panel to its CoreDevice display: a unique name match, else a unique
 * native-size match. simctl and devicectl name displays independently, so the size
 * is what identifies a Duo panel; an ambiguous listing yields no ID (simctl fallback).
 */
export function findDevicectlDisplayUniqueId(
  displays: readonly DevicectlDisplayInfo[],
  panel: Pick<DisplayPanel, "key" | "sizePx">,
): string | undefined {
  return (
    onlyUniqueId(displays.filter((display) => display.name === panel.key)) ??
    onlyUniqueId(displays.filter((display) => sameSize(display.nativeSize, panel.sizePx)))
  );
}

export interface DevicectlScreenshotFiles {
  tmpdir(): string;
  mkdtemp(prefix: string): Promise<string>;
  readFileBuffer(path: string): Promise<Buffer>;
  rm(path: string): Promise<void>;
}

export const defaultDevicectlScreenshotFiles: DevicectlScreenshotFiles = {
  tmpdir,
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  readFileBuffer: (path) => fs.readFile(path),
  rm: (path) => fs.rm(path, { recursive: true, force: true }),
};

/** `xcrun devicectl device capture screenshot` into a private temp directory. */
export class DevicectlDisplayScreenshotCapture implements SimulatorDisplayScreenshotCapture {
  constructor(
    private readonly options: {
      executor: HostCommandExecutor;
      files: DevicectlScreenshotFiles;
      timer: Timer;
      timeoutMs: number;
      logger: Pick<Logger, "warn">;
    },
  ) {}

  async capture(request: {
    deviceId: string;
    displayUniqueId: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const { files } = this.options;
    const directory = await files.mkdtemp(join(files.tmpdir(), "automobile-devicectl-shot-"));
    try {
      const destination = join(directory, "panel.png");
      await this.execute(
        buildDevicectlDisplayScreenshotArgs({
          deviceId: request.deviceId,
          destination,
          displayUniqueId: request.displayUniqueId,
        }),
        request.signal,
      );
      return await files.readFileBuffer(destination);
    } finally {
      await this.cleanup(directory);
    }
  }

  private async execute(args: string[], signal: AbortSignal | undefined): Promise<void> {
    const { executor, timer, timeoutMs } = this.options;
    const timeout = new AbortController();
    const execSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const result = await raceWithDeadline(
      () =>
        executor.executeCommand("xcrun", args, {
          timeoutMs,
          signal: execSignal,
          killSignal: "SIGKILL",
        }),
      {
        timer,
        timeoutMs,
        signal,
        label: "devicectl screenshot",
        timeoutError: () => new Error(`devicectl screenshot timed out after ${timeoutMs}ms`),
        onTimeout: () => timeout.abort(),
      },
    );
    if (result.error) {
      throw new Error(`devicectl screenshot failed: ${result.error}`);
    }
  }

  private async cleanup(directory: string): Promise<void> {
    try {
      await this.options.files.rm(directory);
    } catch (error) {
      this.options.logger.warn(
        `devicectl screenshot cleanup failed: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

/** Resolves undefined whenever the caller should keep its simctl panel capture. */
export interface SimulatorPanelScreenshotSource {
  capturePanel(request: {
    deviceId: string;
    panel: DisplayPanel;
    panelCount: number;
    signal?: AbortSignal;
  }): Promise<Buffer | undefined>;
}

function capabilityDetail(capability: CoreDeviceCapabilityResult): string {
  switch (capability.kind) {
    case "supported":
      return "supported";
    case "notBooted":
      return capability.error.message;
    case "failed":
      return capability.message;
    default:
      return capability.reason;
  }
}

/**
 * Per-panel capture through CoreDevice, gated on the boot-first capability probe.
 * Every call re-reads `device info displays` through that probe, so the panel's
 * unique ID is never cached; anything short of a supported check with exactly one
 * matching display, or any devicectl failure, falls back to simctl.
 */
export class DevicectlPanelScreenshotSource implements SimulatorPanelScreenshotSource {
  constructor(
    private readonly options: {
      probes: CoreDeviceProbeHolder;
      capture: SimulatorDisplayScreenshotCapture;
      timer: Timer;
      logger: Logger;
    },
  ) {}

  async capturePanel(request: {
    deviceId: string;
    panel: DisplayPanel;
    panelCount: number;
    signal?: AbortSignal;
  }): Promise<Buffer | undefined> {
    const { deviceId, panel, panelCount, signal } = request;
    if (panelCount < 2) {
      return undefined;
    }
    const { logger: log } = this.options;
    try {
      const capability = await raceWithDeadline(
        () =>
          this.options.probes
            .get()
            .checkSimulatorCommand(
              deviceId,
              DEVICECTL_DISPLAYS_COMMAND,
              REQUIRED_SIMULATOR_COREDEVICE_VERSION,
            ),
        { timer: this.options.timer, signal, label: "CoreDevice display check" },
      );
      const transport = chooseSimulatorPanelScreenshotTransport({
        panelCount,
        panelKey: panel.key,
        displayUniqueId: this.displayUniqueId(capability, panel),
        capability,
      });
      if (transport.kind === "simctl") {
        // An unsupported host or an unmatched panel is an expected route, not a failure.
        log.debug(
          `[SCREENSHOT] iOS panel ${panel.key}: devicectl not used (${transport.reason}: ${capabilityDetail(capability)}); using simctl`,
        );
        return undefined;
      }
      return await this.options.capture.capture({
        deviceId,
        displayUniqueId: transport.displayUniqueId,
        signal,
      });
    } catch (error) {
      log.warn(
        `[SCREENSHOT] iOS panel ${panel.key} devicectl capture failed; using simctl: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private displayUniqueId(
    capability: CoreDeviceCapabilityResult,
    panel: DisplayPanel,
  ): string | undefined {
    if (capability.kind !== "supported" || capability.output === undefined) {
      return undefined;
    }
    const listing = parseDevicectlDisplayInfo(capability.output, this.options.logger);
    return listing.kind === "ok"
      ? findDevicectlDisplayUniqueId(listing.displays, panel)
      : undefined;
  }
}

export function createProductionDevicectlPanelScreenshotSource(
  options: { probes?: CoreDeviceProbeHolder } = {},
): DevicectlPanelScreenshotSource {
  return new DevicectlPanelScreenshotSource({
    probes: options.probes ?? sharedCoreDeviceProbeHolder,
    capture: new DevicectlDisplayScreenshotCapture({
      executor: new DefaultHostCommandExecutor(),
      files: defaultDevicectlScreenshotFiles,
      timer: defaultTimer,
      timeoutMs: DEVICECTL_SCREENSHOT_TIMEOUT_MS,
      logger,
    }),
    timer: defaultTimer,
    logger,
  });
}
