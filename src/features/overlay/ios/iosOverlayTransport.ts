/**
 * The shared overlay transport over the injected iOS simulator overlay agent (#10568).
 *
 * The agent speaks the CtrlProxy overlay message names, so requests and `overlay_event` pushes
 * map one to one. It has no `update_overlay` (#10550): a same-id `show` replaces the overlay.
 * It has no display targeting. `reset` is forwarded to start a same-id show fresh. Per-call `timeoutMs` is not forwarded: the agent client applies
 * its own request timeout to every request.
 */
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { OverlayAssetRequestOptions } from "../../observe/android/CtrlProxyOverlays";
import { overlayEventSchema } from "../../observe/android/CtrlProxyOverlays";
import {
  OVERLAY_SHOW_IN_PLACE_CAPABILITY,
  SCREENSHOT_HIDE_OVERLAY_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
} from "../../observe/android/ctrlProxyProtocol";
import {
  overlayAssetIdProblem,
  overlayAssetUploadProblem,
  type OverlayAssetUpload,
} from "../overlayAssets";
import type { OverlaySpec } from "../overlaySpec";
import type {
  OverlayDeviceStatus,
  OverlayShowOptions,
  OverlayTransport,
} from "../OverlayTransport";
import type {
  OverlayAgentClient,
  OverlayAgentMessage,
  OverlayAgentRequestType,
  OverlayAgentResult,
} from "./overlayAgentClient";

/**
 * Live agent connections by device. `launchApp {overlay: true}` (#10567) owns the registry: it
 * records the port and token, connects, replaces the entry when the app relaunches and drops it
 * when the connection closes. The prototype tool only looks connections up.
 */
export interface OverlayAgentConnections {
  get(deviceId: string): OverlayAgentClient | undefined;
}

/** No injected agents: every iOS device reports no agent connection. */
export const noOverlayAgentConnections: OverlayAgentConnections = { get: () => undefined };

/**
 * Capability the agent advertises when it can hide itself around a host screenshot (#9305); one
 * string shared with Android CtrlProxy, defined with the other overlay capability flags.
 */
export { SCREENSHOT_HIDE_OVERLAY_CAPABILITY };

/** The agent restores the overlay by itself after this long, even if the host never asks. */
export const DEFAULT_CAPTURE_HIDE_DEADLINE_MS = 1500;

export interface CaptureWithOverlayHidden<T> {
  value: T;
  /** False only when the agent confirmed the overlay was hidden for the whole capture. */
  screenshotIncludesOverlay: boolean;
  /**
   * True when the agent never confirmed a hide (no capability, a failed request): the overlay may
   * be in the image. Absent when the agent answered, even with `hidden: false` (nothing was
   * visible to hide), where the image is known to exclude it.
   */
  hideUnconfirmed?: true;
}

export function overlayAgentNotConnectedMessage(deviceId: string): string {
  return (
    `No overlay agent is connected for iOS device ${deviceId}. Overlays on iOS need the injected ` +
    "overlay agent, which runs on simulators only: call launchApp with overlay: true for the app " +
    "to prototype on, then retry."
  );
}

function toOverlayResult(result: OverlayAgentResult): OverlayResult {
  const { missingAssets, totalTimeMs } = result;
  return {
    success: result.success,
    requestId: result.requestId,
    ...(typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof totalTimeMs === "number" ? { totalTimeMs } : {}),
    ...(Array.isArray(missingAssets) &&
    missingAssets.every((id): id is string => typeof id === "string") &&
    missingAssets.length > 0
      ? { missingAssets }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class IosOverlayTransport implements OverlayTransport {
  constructor(private readonly agent: OverlayAgentClient) {}

  /**
   * Whether the agent's handshake advertised `capability`: a request type, or a spec feature it
   * renders such as `overlay_anchor_v1`. An older agent draws what it does not know unpositioned.
   */
  supportsCapability(capability: string): boolean {
    return this.agent.handshake.capabilities.includes(capability);
  }

  /**
   * Runs `capture` (the host's simulator screenshot) with the overlay hidden: `hide_for_capture`
   * is answered only once the hide is on screen, then `restore_after_capture` follows even when
   * the capture throws. The agent also restores at `deadlineMs` on its own, so a cancelled host
   * cannot leave the overlay hidden. Without the capability, or when the hide fails, the capture
   * still runs and reports `screenshotIncludesOverlay: true` so callers can annotate it.
   */
  async captureWithOverlayHidden<T>(
    capture: () => Promise<T>,
    deadlineMs: number = DEFAULT_CAPTURE_HIDE_DEADLINE_MS,
  ): Promise<CaptureWithOverlayHidden<T>> {
    if (!this.supportsCapability(SCREENSHOT_HIDE_OVERLAY_CAPABILITY)) {
      return { value: await capture(), screenshotIncludesOverlay: true, hideUnconfirmed: true };
    }
    let holding = false;
    let hidden = false;
    try {
      const reply = await this.agent.request("hide_for_capture", { deadlineMs });
      holding = reply.success;
      hidden = holding && reply.hidden !== false;
    } catch (error) {
      logger.warn(`[overlay-agent] hide_for_capture failed: ${errorMessage(error)}`, error);
    }
    try {
      const value = await capture();
      return {
        value,
        screenshotIncludesOverlay: !hidden,
        ...(holding ? {} : ({ hideUnconfirmed: true } as const)),
      };
    } finally {
      if (holding) {
        await this.agent.request("restore_after_capture").catch((error: unknown) => {
          // The agent's own deadline restores the overlay, so a lost restore is not fatal.
          logger.warn(
            `[overlay-agent] restore_after_capture failed: ${errorMessage(error)}`,
            error,
          );
        });
      }
    }
  }

  /**
   * A same-id show replaces the overlay in place; `reset: true` starts it fresh (pager pages from
   * the spec). The field is sent only when true, as on Android. An agent that predates it would
   * silently keep the pages, so `reset` is refused unless the handshake advertises
   * `overlay_show_in_place_v1`.
   */
  async show(spec: OverlaySpec, options: OverlayShowOptions = {}): Promise<OverlayResult> {
    if (options.reset === true && !this.supportsCapability(OVERLAY_SHOW_IN_PLACE_CAPABILITY)) {
      throw new ActionableError(
        `Overlay agent ${this.agent.handshake.agentVersion} does not support reset; relaunch ` +
          "the app with launchApp overlay: true to load the agent built for this AutoMobile version.",
      );
    }
    return toOverlayResult(
      await this.agent.request("show_overlay", {
        spec,
        ...(options.reset === true ? { reset: true } : {}),
      }),
    );
  }

  async dismiss(target: OverlayDismiss): Promise<OverlayResult> {
    const body: OverlayAgentMessage = target.all ? { all: true } : { id: target.id };
    return toOverlayResult(await this.agent.request("dismiss_overlay", body));
  }

  async putAsset(
    asset: OverlayAssetUpload,
    options: OverlayAssetRequestOptions = {},
  ): Promise<OverlayAssetResult> {
    const problem = overlayAssetUploadProblem(asset);
    if (problem !== null) {
      throw new ActionableError(`Invalid overlay asset: ${problem}`);
    }
    const { bytes } = asset;
    const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    return this.assetRequest(
      "put_overlay_asset",
      { id: asset.id, mimeType: asset.mimeType, dataBase64 },
      `Upload of overlay asset '${asset.id}'`,
      options,
    );
  }

  async removeAsset(
    id: string,
    options: OverlayAssetRequestOptions = {},
  ): Promise<OverlayAssetResult> {
    const problem = overlayAssetIdProblem(id);
    if (problem !== null) {
      throw new ActionableError(`Invalid overlay asset: ${problem}`);
    }
    return this.assetRequest(
      "remove_overlay_asset",
      { id },
      `Removal of overlay asset '${id}'`,
      options,
    );
  }

  async status(): Promise<OverlayDeviceStatus> {
    const result = await this.agent.request("get_overlay_status");
    return {
      success: result.success,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
      ...(isRecord(result.status) ? { status: result.status } : {}),
    };
  }

  onEvent(listener: (event: OverlayEvent) => void): () => void {
    return this.agent.onEvent((message) => {
      // Decode at the push boundary, as CtrlProxy does: malformed frames never reach listeners.
      const decoded = overlayEventSchema.safeParse(message);
      if (!decoded.success) {
        logger.warn("[overlay-agent] Dropping malformed overlay_event", decoded.error);
        return;
      }
      listener(decoded.data);
    });
  }

  /**
   * Same outcome contract as CtrlProxy asset requests: aborting before dispatch sends nothing,
   * and a request that never got an answer is indeterminate (re-sending is safe; ids replace).
   */
  private async assetRequest(
    type: OverlayAgentRequestType,
    body: OverlayAgentMessage,
    label: string,
    options: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    if (options.abortSignal?.aborted) {
      return {
        success: false,
        error: `${label} was cancelled before it was sent.`,
        dispatched: false,
        acknowledged: false,
      };
    }
    // An unsupported request is refused before anything is sent, so it is not indeterminate.
    if (!this.agent.handshake.capabilities.includes(type)) {
      throw new ActionableError(
        `Overlay agent ${this.agent.handshake.agentVersion} does not support ${type}; relaunch ` +
          "the app with launchApp overlay: true to load the agent built for this AutoMobile version.",
      );
    }
    try {
      const pending = this.agent.request(type, body);
      options.onDispatch?.();
      const result = await pending;
      return { ...toOverlayResult(result), dispatched: true, acknowledged: true };
    } catch (error) {
      logger.warn(`[overlay-agent] ${label} got no answer: ${errorMessage(error)}`, error);
      return {
        success: false,
        error:
          `${label} outcome is indeterminate: no agent reply was confirmed (${errorMessage(error)}). ` +
          "The asset may or may not be stored; sending the same request again is safe.",
        dispatched: true,
        acknowledged: false,
      };
    }
  }
}
