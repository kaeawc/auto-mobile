import type { Socket } from "node:net";
import type { ObserveResult, ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { deviceSessionErrorFields, type DeviceSessionResolver } from "../deviceSessionResolver";
import { streamAuthRefusalFields, type StreamSocketAuthenticator } from "../streamSocketAuth";
import type { SubscriptionResponse } from "../socketServer/index";
import type {
  NavigationGraphStreamData,
  OnNavigationGraphRequestedCallback,
  OnObservationRequestedCallback,
  RequestedObservation,
} from "./streamContracts";

// iOS observe (ViewHierarchy.getiOSViewHierarchy -> getLatestHierarchy) can
// legitimately wait up to 15s for a fresh hierarchy. Keep this wrapper timeout
// above that so slow-but-valid iOS captures are not reported as stream errors
// before the platform observe path has its allotted time to complete.
export const DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS = 20_000;

interface NavigationGraphResponse {
  id?: string;
  type: "navigation_update";
  deviceSessionUuid: string | null;
  deviceId?: string;
  timestamp: number;
  navigationGraph: NavigationGraphStreamData;
}

export interface StreamRequestsHost {
  readonly timer: Timer;
  readonly authenticator: StreamSocketAuthenticator;
  getDeviceSessionResolver(): DeviceSessionResolver;
  parseDeviceSessionUuid(value: unknown): string | null;
  sendJson(socket: Socket, message: SubscriptionResponse | NavigationGraphResponse): void;
  captureFrameContextGenerations(): {
    generations: ReadonlyMap<string, number>;
    untrackedGeneration: number;
  };
  getCurrentFrameContextGeneration(deviceId: string): number;
  pushHierarchyUpdate(
    deviceId: string,
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
  ): number | null;
}

/** Handles on-demand observation and navigation requests through the server's routing boundary. */
export class StreamRequests {
  constructor(private readonly host: StreamRequestsHost) {}

  private onObservationRequested: OnObservationRequestedCallback | null = null;
  private onNavigationGraphRequested: OnNavigationGraphRequestedCallback | null = null;
  private observationRequestTimeoutMs = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS;

  /**
   * Set a callback to handle on-demand observation requests.
   */
  setOnObservationRequested(
    callback: OnObservationRequestedCallback,
    timeoutMs: number = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
  ): void {
    this.onObservationRequested = callback;
    this.observationRequestTimeoutMs = timeoutMs;
  }

  /**
   * Set a callback to handle on-demand navigation graph requests.
   */
  setOnNavigationGraphRequested(callback: OnNavigationGraphRequestedCallback): void {
    this.onNavigationGraphRequested = callback;
  }

  async handleNavigationGraphRequest(
    socket: Socket,
    request: { id?: string; sessionUuid?: string; deviceSessionUuid?: string; appId?: string },
  ): Promise<void> {
    try {
      const deviceSessionUuid = this.host.parseDeviceSessionUuid(request.deviceSessionUuid);
      const deviceId =
        deviceSessionUuid === null
          ? undefined
          : (this.host.getDeviceSessionResolver().resolveDeviceId(deviceSessionUuid) ?? undefined);
      if (deviceSessionUuid !== null && deviceId === undefined) {
        throw this.host.getDeviceSessionResolver().getSessionError(deviceSessionUuid);
      }
      // Reading the navigation graph is watching (#10830): any live identity may, held or not.
      this.host.authenticator.authorize({
        sessionUuid: request.sessionUuid,
        deviceId,
        admitViewer: true,
      });
      if (!this.onNavigationGraphRequested) {
        this.host.sendJson(socket, {
          id: request.id,
          type: "subscription_response",
          success: true,
        } satisfies SubscriptionResponse);
        return;
      }
      const graphData = await this.onNavigationGraphRequested(request.appId ?? null);
      if (graphData) {
        // Echo the requester's device-session key so the pane can attribute this
        // on-demand response to its own device (epic #5256, item 3; #4837 AC2).
        const message: NavigationGraphResponse = {
          id: request.id,
          type: "navigation_update",
          deviceSessionUuid,
          deviceId,
          timestamp: this.host.timer.now(),
          navigationGraph: graphData,
        };
        this.host.sendJson(socket, message);
      } else {
        const response: SubscriptionResponse = {
          id: request.id,
          type: "subscription_response",
          success: true,
        };
        this.host.sendJson(socket, response);
      }
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error handling request_navigation_graph: ${error}`);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...streamAuthRefusalFields(error),
        ...deviceSessionErrorFields(error),
      };
      this.host.sendJson(socket, errorResponse);
    }
  }

  async handleObservationRequest(
    socket: Socket,
    request: { id?: string; deviceId?: string; deviceSessionUuid?: string; sessionUuid?: string },
    assertDeviceActionable: (deviceId: string) => void,
  ): Promise<void> {
    try {
      const deviceSessionUuid = this.host.parseDeviceSessionUuid(request.deviceSessionUuid);
      const deviceId =
        deviceSessionUuid === null
          ? request.deviceId
          : (this.host.getDeviceSessionResolver().resolveDeviceId(deviceSessionUuid) ?? undefined);
      if (deviceSessionUuid !== null && deviceId === undefined) {
        throw this.host.getDeviceSessionResolver().getSessionError(deviceSessionUuid);
      }
      // An on-demand observation is watching, like the passive subscribe (#10830): a held device
      // admits any live identity as a read-only viewer (#10698).
      this.host.authenticator.authorize({
        sessionUuid: request.sessionUuid,
        deviceId,
        admitViewer: true,
      });
      if (!this.onObservationRequested) {
        throw new Error("Observation requests are not available");
      }
      // FUNNEL 2, BEFORE observing. A device-specific request names the serial,
      // and the quarantine is precisely the pool's inability to say which runtime
      // answers on it. Without this the handler observed the unknown runtime,
      // `pushForDevice` then dropped every frame because routing is suspended,
      // and the requester was acknowledged `success: true` with no hierarchy
      // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
      if (deviceId !== undefined) {
        assertDeviceActionable(deviceId);
      }
      const {
        generations: frameContextGenerationsAtStart,
        untrackedGeneration: untrackedGenerationAtStart,
      } = this.host.captureFrameContextGenerations();
      const observations = await this.requestObservationWithTimeout({
        deviceId: deviceId ?? null,
        sessionUuid: request.sessionUuid,
        requestId: request.id,
      });
      if (observations.length === 0) {
        throw new Error("Observation request did not capture any devices");
      }

      const failures = this.pushObservedHierarchies(
        observations,
        frameContextGenerationsAtStart,
        untrackedGenerationAtStart,
      );

      if (failures.length > 0) {
        // Healthy devices already received their hierarchy_update pushes above;
        // report the per-device failures so the client can display/retry them.
        const errorResponse: SubscriptionResponse = {
          id: request.id,
          type: "error",
          success: false,
          error: failures.join("; "),
        };
        this.host.sendJson(socket, errorResponse);
        return;
      }

      const response: SubscriptionResponse = {
        id: request.id,
        type: "subscription_response",
        success: true,
      };
      this.host.sendJson(socket, response);
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error handling request_observation: ${error}`);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...streamAuthRefusalFields(error),
        ...deviceSessionErrorFields(error),
      };
      this.host.sendJson(socket, errorResponse);
    }
  }

  /**
   * Push each observed hierarchy independently and return the per-device
   * failures, so that for an all-device request a healthy device still receives
   * its refresh even when another device produced nothing. Failures are surfaced
   * in the response rather than aborting the batch.
   *
   * A device whose pooled identity is quarantined is one of those failures: FUNNEL
   * 2 cannot preflight an all-device request, which names no serial, and
   * `pushForDevice` would drop that serial's frames because routing is suspended —
   * delivering nothing while the requester is acknowledged `success: true`, the
   * same false acknowledgement the device-specific form was fixed for
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  private pushObservedHierarchies(
    observations: readonly RequestedObservation[],
    frameContextGenerationsAtStart: ReadonlyMap<string, number>,
    untrackedGenerationAtStart: number,
  ): string[] {
    const failures: string[] = [];
    for (const { deviceId, observation } of observations) {
      if (this.host.getDeviceSessionResolver().isRoutingSuspended(deviceId)) {
        failures.push(
          `Observation request failed for ${deviceId}: its pooled AVD identity is unresolved, ` +
            "so there is no routing identity to attribute the hierarchy to",
        );
        continue;
      }
      const hierarchy = observation.viewHierarchy;
      if (!hierarchy) {
        failures.push(this.describeMissingHierarchy(deviceId, observation));
        continue;
      }
      if (
        this.host.getCurrentFrameContextGeneration(deviceId) !==
        (frameContextGenerationsAtStart.get(deviceId) ?? untrackedGenerationAtStart)
      ) {
        logger.debug(
          `[DeviceDataStream] Skipped stale explicit observation for ${deviceId}; a newer hierarchy or full boundary intervened`,
        );
        continue;
      }
      this.host.pushHierarchyUpdate(deviceId, hierarchy, hierarchy.frameContext);
    }
    return failures;
  }

  private describeMissingHierarchy(deviceId: string, observation: ObserveResult): string {
    const observationError =
      observation.error ??
      observation.errors?.map((error) => error.message).join("; ") ??
      "Observation did not include view hierarchy";
    return `Observation request failed for ${deviceId}: ${observationError}`;
  }

  private async requestObservationWithTimeout(request: {
    deviceId: string | null;
    sessionUuid?: string;
    requestId?: string;
  }): Promise<RequestedObservation[]> {
    const controller = new AbortController();
    return await raceWithDeadline(
      this.onObservationRequested!({
        deviceId: request.deviceId,
        sessionUuid: request.sessionUuid,
        requestId: request.requestId,
        signal: controller.signal,
      }),
      {
        timer: this.host.timer,
        timeoutMs: this.observationRequestTimeoutMs,
        label: "Observation request",
        timeoutError: () =>
          new Error(`Observation request timed out after ${this.observationRequestTimeoutMs}ms`),
        onTimeout: () => controller.abort(),
      },
    );
  }
}
