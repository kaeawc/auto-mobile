import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { DisplayPanel } from "../../models/DisplayPanel";
import {
  REQUIRED_SIMULATOR_COREDEVICE_VERSION,
  type CoreDeviceCapabilityResult,
} from "./CoreDeviceCapabilityProbe";
import { sharedCoreDeviceProbeHolder, type CoreDeviceProbeHolder } from "./CoreDeviceProbeHolder";
import { parseDevicectlDisplayInfo } from "./DevicectlDisplayInfo";
import {
  chooseSimulatorPanelScreenshotTransport,
  DEVICECTL_DISPLAYS_COMMAND,
  DEVICECTL_SCREENSHOT_TIMEOUT_MS,
  DevicectlDisplayScreenshotCapture,
  defaultDevicectlScreenshotFiles,
  findDevicectlDisplayUniqueId,
  type SimulatorDisplayScreenshotCapture,
  type SimulatorPanelScreenshotSource,
} from "./DevicectlDisplayScreenshot";

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
