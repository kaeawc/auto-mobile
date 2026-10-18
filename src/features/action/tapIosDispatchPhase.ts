import type { BootedDevice, Element } from "../../models";
import { IOSCtrlProxyClient } from "../observe/ios";
import type { DisplayFenceOption } from "./BaseVisualChange";
import { dispatchIosCoordinateTap, dispatchIosDoubleTap } from "./coordinateTapDispatch";
import { tapViaVoiceOver } from "./tapIosVoiceOver";

/** Internal action context; never part of the public tapOn schema. */
export type IosTapOptions = DisplayFenceOption & { signal?: AbortSignal };

/** Positional arguments of the iOS tap dispatch; the last three are optional. */
export type IosTapArgs = [
  action: string,
  x: number,
  y: number,
  durationMs: number,
  element?: Element,
  isVoiceOverEnabled?: boolean,
  fenceOptions?: IosTapOptions,
];

/** What the iOS dispatch phase needs from the owning tap action. */
export interface TapIosDispatchHost {
  readonly device: BootedDevice;
  /** Routed through the owner so overriding/spying on it observes the VoiceOver fallback too. */
  executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions?: IosTapOptions,
  ): Promise<void>;
  executeIOSTapWithVoiceOver(
    action: string,
    element: Element,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions?: IosTapOptions,
  ): Promise<void>;
}

/** iOS coordinate tap / double tap / long press and VoiceOver activation dispatch for tapOn. */
export class TapIosDispatchPhase {
  constructor(private readonly host: TapIosDispatchHost) {}

  async executeiOSTap(...args: IosTapArgs): Promise<void> {
    const [action, x, y, durationMs, element, isVoiceOverEnabled, fenceOptions = {}] = args;
    if (isVoiceOverEnabled && element) {
      await this.host.executeIOSTapWithVoiceOver(action, element, x, y, durationMs, fenceOptions);
      return;
    }

    await this.host.executeiOSTapWithCoordinates(action, x, y, durationMs, fenceOptions);
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode)
   */
  async executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions: IosTapOptions = {},
  ): Promise<void> {
    const { displayFence: fence, signal } = fenceOptions;
    // Use short duration (50ms) for tap/doubleTap, full duration for longPress
    const tapDuration = action === "longPress" ? durationMs : 50;

    const client = IOSCtrlProxyClient.getInstance(this.host.device);

    if (action === "doubleTap") {
      fence?.assertCurrent();
      await dispatchIosDoubleTap(client, x, y, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.host.device.deviceId)?.invalidateCache();
    } else {
      // Single tap or long press
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, x, y, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.host.device.deviceId)?.invalidateCache();
    }
  }

  /** VoiceOver activation with a coordinate-tap fallback; see {@link tapViaVoiceOver}. */
  executeIOSTapWithVoiceOver(
    action: string,
    element: Element,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions?: IosTapOptions,
  ): Promise<void> {
    return tapViaVoiceOver({
      device: this.host.device,
      action,
      element,
      point: { x, y },
      durationMs,
      fenceOptions: fenceOptions ?? {},
      coordinateTap: (opts) =>
        this.host.executeiOSTapWithCoordinates(action, x, y, durationMs, opts),
    });
  }
}
