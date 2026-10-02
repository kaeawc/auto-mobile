import type { BootedDevice } from "../../models";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { fixedBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

// Match the clock restore cadence in sessionManager.ts; simctl gets a 5s attempt budget.
const MOCK_LOCATION_CLEAR_RETRY_DELAY_MS = 250;
const MOCK_LOCATION_CLEAR_TIMEOUT_MS = 5_000;

export interface MockLocationClears {
  markSet(sessionId: string, device: BootedDevice): void;
  clearLateSet(options: { sessionId: string; device: BootedDevice }): Promise<void> | null;
  clearAfter(sessionId: string, deviceId: string, settled: Promise<unknown>): Promise<void> | null;
  retireDevice(deviceId: string): void;
}

interface LocationMarker {
  sessionId: string;
  device: BootedDevice;
  controller: AbortController;
  cleanup?: Promise<void>;
}

interface MockLocationClearOptions {
  timer?: Timer;
  simctlFactory?: (device: BootedDevice) => Pick<SimCtlClient, "executeCommandArgs">;
  backoff?: BackoffPolicy;
}

/** In-memory session ownership only; Android's console has no location unset command. */
export class MockLocationClearRegistry implements MockLocationClears {
  private readonly markers = new Map<string, LocationMarker>();
  private readonly timer: Timer;
  private readonly simctlFactory: NonNullable<MockLocationClearOptions["simctlFactory"]>;
  private readonly backoff: BackoffPolicy;

  constructor(options: MockLocationClearOptions = {}) {
    this.timer = options.timer ?? defaultTimer;
    this.simctlFactory = options.simctlFactory ?? ((device) => new SimCtlClient(device));
    this.backoff = options.backoff ?? fixedBackoff(MOCK_LOCATION_CLEAR_RETRY_DELAY_MS);
  }

  markSet(sessionId: string, device: BootedDevice): void {
    this.rememberSet(sessionId, device);
  }

  /** A released owner's late fix needs immediate cleanup, not new session attribution. */
  clearLateSet(options: { sessionId: string; device: BootedDevice }): Promise<void> | null {
    this.rememberSet(options.sessionId, options.device);
    return this.clearAfter(options.sessionId, options.device.deviceId, Promise.resolve());
  }

  private rememberSet(sessionId: string, device: BootedDevice): void {
    if (device.platform !== "ios" || !isIosSimulatorDevice(device)) {
      return;
    }
    const previous = this.markers.get(device.deviceId);
    if (previous?.sessionId === sessionId) {
      return;
    }
    this.markers.set(device.deviceId, { sessionId, device, controller: new AbortController() });
    previous?.controller.abort();
  }

  clearAfter(sessionId: string, deviceId: string, settled: Promise<unknown>): Promise<void> | null {
    const marker = this.markers.get(deviceId);
    if (!marker || marker.sessionId !== sessionId) {
      return null;
    }
    marker.cleanup ??= this.clearWhenSettled(marker, settled);
    return marker.cleanup;
  }

  retireDevice(deviceId: string): void {
    const marker = this.markers.get(deviceId);
    this.markers.delete(deviceId);
    marker?.controller.abort();
    // Device removed, nothing to clear; cancellation releases its quarantine.
    logger.debug(`Mock location device removed, nothing to clear for ${deviceId}`);
  }

  private isCurrent(marker: LocationMarker): boolean {
    return this.markers.get(marker.device.deviceId) === marker;
  }

  private async clearWhenSettled(marker: LocationMarker, settled: Promise<unknown>): Promise<void> {
    try {
      await raceWithDeadline(settled, {
        timer: this.timer,
        signal: marker.controller.signal,
        label: "Location route settlement",
      });
    } catch (error) {
      if (!this.isCurrent(marker)) {
        // Removal or replacement owns any remaining cleanup; this marker is obsolete.
        logger.debug(
          `Mock location settlement cancelled for ${marker.device.deviceId}: ${errorMessage(error)}`,
        );
        return;
      }
      logger.warn(
        `Location settlement failed for ${marker.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
    let attempt = 0;
    while (this.isCurrent(marker)) {
      if (await this.tryClear(marker)) {
        if (this.isCurrent(marker)) {
          this.markers.delete(marker.device.deviceId);
        }
        return;
      }
      if (!this.isCurrent(marker)) {
        return;
      }
      await this.waitForRetry(marker, ++attempt);
    }
  }

  private async tryClear(marker: LocationMarker): Promise<boolean> {
    const attemptController = new AbortController();
    const signal = AbortSignal.any([marker.controller.signal, attemptController.signal]);
    try {
      await raceWithDeadline(
        () =>
          this.simctlFactory(marker.device).executeCommandArgs(
            ["location", marker.device.deviceId, "clear"],
            MOCK_LOCATION_CLEAR_TIMEOUT_MS,
            signal,
          ),
        {
          timer: this.timer,
          timeoutMs: MOCK_LOCATION_CLEAR_TIMEOUT_MS,
          signal,
          unref: true,
          label: "Mock location clear",
          onTimeout: () => attemptController.abort(),
        },
      );
      return true;
    } catch (error) {
      if (!this.isCurrent(marker)) {
        // Removal or supersession ends the old clear quietly.
        logger.debug(
          `Mock location clear cancelled for ${marker.device.deviceId}: ${errorMessage(error)}`,
        );
        return false;
      }
      logger.warn(
        `Mock location clear failed for ${marker.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private async waitForRetry(marker: LocationMarker, attempt: number): Promise<void> {
    try {
      await raceWithDeadline(() => this.timer.sleep(this.backoff.delayForAttempt(attempt)), {
        timer: this.timer,
        signal: marker.controller.signal,
        label: "Mock location clear retry",
      });
    } catch (error) {
      if (!this.isCurrent(marker)) {
        // Device removed or ownership replaced: no further attempt is needed.
        logger.debug(
          `Mock location retry cancelled for ${marker.device.deviceId}: ${errorMessage(error)}`,
        );
        return;
      }
      logger.warn(
        `Mock location retry wait failed for ${marker.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

// Shared by the handler and daemon. The default uses defaultTimer; tests inject FakeTimer.
export const defaultMockLocationClearRegistry = new MockLocationClearRegistry();
