/**
 * The shared prototype transport over the injected iOS simulator prototype agent (#10568).
 *
 * The agent speaks the CtrlProxy prototype message names, so requests and `prototype_event` pushes
 * map one to one. It has no `update_prototype` (#10550): a same-id `show` replaces the prototype.
 * It has no display targeting. `reset` is forwarded to start a same-id show fresh. Per-call `timeoutMs` is not forwarded: the agent client applies
 * its own request timeout to every request.
 */
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { PrototypeAssetRequestOptions } from "../../observe/android/CtrlProxyPrototypes";
import { prototypeEventSchema } from "../../observe/android/CtrlProxyPrototypes";
import {
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol";
import type {
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "../../observe/android/ctrlProxyProtocol";
import {
  prototypeAssetIdProblem,
  prototypeAssetUploadProblem,
  type PrototypeAssetUpload,
} from "../prototypeAssets";
import type { PrototypeSpec } from "../prototypeSpec";
import type {
  PrototypeDeviceStatus,
  PrototypeShowOptions,
  PrototypeTransport,
} from "../PrototypeTransport";
import type {
  PrototypeAgentClient,
  PrototypeAgentMessage,
  PrototypeAgentRequestType,
  PrototypeAgentResult,
} from "./prototypeAgentClient";

/**
 * Live agent connections by device. `launchApp {prototype: true}` (#10567) owns the registry: it
 * records the port and token, connects, replaces the entry when the app relaunches and drops it
 * when the connection closes. The prototype tool only looks connections up.
 */
export interface PrototypeAgentConnections {
  get(deviceId: string): PrototypeAgentClient | undefined;
}

/** No injected agents: every iOS device reports no agent connection. */
export const noPrototypeAgentConnections: PrototypeAgentConnections = { get: () => undefined };

/**
 * Capability the agent advertises when it can hide itself around a host screenshot (#9305); one
 * string shared with Android CtrlProxy, defined with the other prototype capability flags.
 */
export { SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY };

/**
 * Capability the agent advertises when `get_prototype_status` also reports `lastSequence`, which
 * `inspect` adopts. An older agent answers status without it, so inspect is refused on one.
 */
export const IOS_PROTOTYPE_INSPECT_CAPABILITY = "prototype_inspect_v1";

/** The agent restores the prototype by itself after this long, even if the host never asks. */
export const DEFAULT_CAPTURE_HIDE_DEADLINE_MS = 1500;

/** The agent clamps a hold to this (`PrototypeCaptureHold.maxDeadlineMs`); keep the two equal. */
export const MAX_CAPTURE_HIDE_DEADLINE_MS = 15000;

/** Slack on top of the capture's own timeout so a capture that times out still ends inside its hold. */
export const CAPTURE_HIDE_DEADLINE_MARGIN_MS = 1000;

/** The hide deadline for a capture that may take up to `captureTimeoutMs`, within the agent's cap. */
export function captureHideDeadlineMs(captureTimeoutMs: number): number {
  return Math.min(captureTimeoutMs + CAPTURE_HIDE_DEADLINE_MARGIN_MS, MAX_CAPTURE_HIDE_DEADLINE_MS);
}

export interface CaptureWithPrototypeHidden<T> {
  value: T;
  /** False only when the agent confirmed the prototype was hidden for the whole capture. */
  screenshotIncludesPrototype: boolean;
  /**
   * True when the agent never confirmed a hide for the whole capture (no capability, a failed
   * request, a hold that expired before the restore): the prototype may be in the image. Absent when the agent answered, even with `hidden: false` (nothing was
   * visible to hide), where the image is known to exclude it.
   */
  hideUnconfirmed?: true;
}

export function prototypeAgentNotConnectedMessage(deviceId: string): string {
  return (
    `No prototype agent is connected for iOS device ${deviceId}. Prototypes on iOS need the injected ` +
    "prototype agent, which runs on simulators only: call launchApp with prototype: true for the app " +
    "to prototype on, then retry."
  );
}

function toPrototypeResult(result: PrototypeAgentResult): PrototypeResult {
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

export class IosPrototypeTransport implements PrototypeTransport {
  constructor(private readonly agent: PrototypeAgentClient) {}

  /**
   * Whether the agent's handshake advertised `capability`: a request type, or a spec feature it
   * renders such as `prototype_anchor_v1`. An older agent draws what it does not know unpositioned.
   */
  supportsCapability(capability: string): boolean {
    return this.agent.handshake.capabilities.includes(capability);
  }

  /**
   * Runs `capture` (the host's simulator screenshot) with the prototype hidden: `hide_for_capture`
   * is answered only once the hide is on screen, then `restore_after_capture` follows even when
   * the capture throws. The agent also restores at `deadlineMs` on its own, so a cancelled host
   * cannot leave the prototype hidden. Holds are token-counted agent-side, so overlapping captures
   * keep the prototype hidden until the last one restores. Without the capability, when the hide
   * fails, or when the restore reports the hold was no longer live (`restored !== true`), the
   * result carries `hideUnconfirmed` so callers fail closed.
   */
  async captureWithPrototypeHidden<T>(
    capture: () => Promise<T>,
    deadlineMs: number = DEFAULT_CAPTURE_HIDE_DEADLINE_MS,
  ): Promise<CaptureWithPrototypeHidden<T>> {
    if (!this.supportsCapability(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY)) {
      return { value: await capture(), screenshotIncludesPrototype: true, hideUnconfirmed: true };
    }
    let holding = false;
    let hidden = false;
    let token: number | undefined;
    try {
      const reply = await this.agent.request("hide_for_capture", { deadlineMs });
      holding = reply.success;
      hidden = holding && reply.hidden !== false;
      token = typeof reply.token === "number" ? reply.token : undefined;
    } catch (error) {
      logger.warn(`[prototype-agent] hide_for_capture failed: ${errorMessage(error)}`, error);
    }
    let value: T;
    try {
      value = await capture();
    } catch (error) {
      if (holding) {
        await this.restoreHold(token);
      }
      throw error;
    }
    // `restored !== true` means this hold was no longer live when the capture finished: its
    // deadline passed, so the prototype may have come back mid-capture. Fail closed, like Android.
    const holdSurvived = holding && (await this.restoreHold(token)) === true;
    return {
      value,
      screenshotIncludesPrototype: !hidden,
      ...(holdSurvived ? {} : ({ hideUnconfirmed: true } as const)),
    };
  }

  /** `restore_after_capture` for one hold; undefined when the reply was lost. */
  private async restoreHold(token: number | undefined): Promise<boolean | undefined> {
    try {
      const reply = await this.agent.request(
        "restore_after_capture",
        token === undefined ? undefined : { token },
      );
      return reply.restored === true;
    } catch (error) {
      // The agent's own deadline restores the prototype, so a lost restore is not fatal here; the
      // capture is still reported unconfirmed because the hold's survival is unknown.
      logger.warn(`[prototype-agent] restore_after_capture failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  /**
   * A same-id show replaces the prototype in place; `reset: true` starts it fresh (pager pages from
   * the spec). The field is sent only when true, as on Android. An agent that predates it would
   * silently keep the pages, so `reset` is refused unless the handshake advertises
   * `prototype_show_in_place_v1`.
   */
  async show(spec: PrototypeSpec, options: PrototypeShowOptions = {}): Promise<PrototypeResult> {
    if (options.reset === true && !this.supportsCapability(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY)) {
      throw new ActionableError(
        `Prototype agent ${this.agent.handshake.agentVersion} does not support reset; relaunch ` +
          "the app with launchApp prototype: true to load the agent built for this AutoMobile version.",
      );
    }
    return toPrototypeResult(
      await this.agent.request("show_prototype", {
        spec,
        ...(options.reset === true ? { reset: true } : {}),
      }),
    );
  }

  async dismiss(target: PrototypeDismiss): Promise<PrototypeResult> {
    const body: PrototypeAgentMessage = target.all ? { all: true } : { id: target.id };
    return toPrototypeResult(await this.agent.request("dismiss_prototype", body));
  }

  async putAsset(
    asset: PrototypeAssetUpload,
    options: PrototypeAssetRequestOptions = {},
  ): Promise<PrototypeAssetResult> {
    const problem = prototypeAssetUploadProblem(asset);
    if (problem !== null) {
      throw new ActionableError(`Invalid prototype asset: ${problem}`);
    }
    const { bytes } = asset;
    const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    return this.assetRequest(
      "put_prototype_asset",
      { id: asset.id, mimeType: asset.mimeType, dataBase64 },
      `Upload of prototype asset '${asset.id}'`,
      options,
    );
  }

  async removeAsset(
    id: string,
    options: PrototypeAssetRequestOptions = {},
  ): Promise<PrototypeAssetResult> {
    const problem = prototypeAssetIdProblem(id);
    if (problem !== null) {
      throw new ActionableError(`Invalid prototype asset: ${problem}`);
    }
    return this.assetRequest(
      "remove_prototype_asset",
      { id },
      `Removal of prototype asset '${id}'`,
      options,
    );
  }

  async status(): Promise<PrototypeDeviceStatus> {
    const result = await this.agent.request("get_prototype_status");
    return {
      success: result.success,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
      ...(isRecord(result.status) ? { status: result.status } : {}),
    };
  }

  onEvent(listener: (event: PrototypeEvent) => void): () => void {
    return this.agent.onEvent((message) => {
      // Decode at the push boundary, as CtrlProxy does: malformed frames never reach listeners.
      const decoded = prototypeEventSchema.safeParse(message);
      if (!decoded.success) {
        logger.warn("[prototype-agent] Dropping malformed prototype_event", decoded.error);
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
    type: PrototypeAgentRequestType,
    body: PrototypeAgentMessage,
    label: string,
    options: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
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
        `Prototype agent ${this.agent.handshake.agentVersion} does not support ${type}; relaunch ` +
          "the app with launchApp prototype: true to load the agent built for this AutoMobile version.",
      );
    }
    try {
      const pending = this.agent.request(type, body);
      options.onDispatch?.();
      const result = await pending;
      return { ...toPrototypeResult(result), dispatched: true, acknowledged: true };
    } catch (error) {
      logger.warn(`[prototype-agent] ${label} got no answer: ${errorMessage(error)}`, error);
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
