import type { Element } from "../../src/models/Element";
import type {
  TalkBackTapResult,
  TalkBackFallbackAction,
  TalkBackTapStrategy,
} from "../../src/features/talkback/TalkBackTapStrategy";
import type { TalkBackNavigationDriver } from "../../src/features/talkback/TalkBackNavigationDriver";

type TalkBackTapStrategyContract = Pick<
  TalkBackTapStrategy,
  | "executeTap"
  | "executeDirectActivation"
  | "executeCoordinateFallback"
  | "executePreciseTap"
  | "executeLongPress"
>;

/**
 * Fake implementation of TalkBackTapStrategy for testing TapOnElement delegation.
 */
export class FakeTalkBackTapStrategy implements TalkBackTapStrategyContract {
  tapResult: TalkBackTapResult = { success: true, method: "focus-navigation" };
  fallbackResult: TalkBackTapResult = { success: true, method: "coordinate-fallback" };
  preciseTapResult: TalkBackTapResult = {
    success: true,
    method: "coordinate-fallback",
    focusCompleted: true,
    completedTaps: 2,
  };
  longPressResult: TalkBackTapResult = { success: true, method: "accessibility-action" };
  directActivationResult: TalkBackTapResult = { success: true, method: "accessibility-action" };

  tapCalls: Array<{
    deviceId: string;
    element: Element;
  }> = [];

  directActivationCalls: Array<{
    element: Element;
  }> = [];

  fallbackCalls: Array<{
    x: number;
    y: number;
    action: TalkBackFallbackAction;
    durationMs: number;
  }> = [];

  preciseTapCalls: Array<{
    x: number;
    y: number;
  }> = [];

  longPressCalls: Array<{
    x: number;
    y: number;
    durationMs: number;
    element: Element;
  }> = [];

  private tapOverrides: TalkBackTapResult[] = [];
  private fallbackOverrides: TalkBackTapResult[] = [];
  private longPressOverrides: TalkBackTapResult[] = [];
  private directActivationOverrides: TalkBackTapResult[] = [];

  setTapResult(result: TalkBackTapResult): void {
    this.tapResult = result;
  }

  setDirectActivationResult(result: TalkBackTapResult): void {
    this.directActivationResult = result;
  }

  queueDirectActivationResult(result: TalkBackTapResult): void {
    this.directActivationOverrides.push(result);
  }

  setFallbackResult(result: TalkBackTapResult): void {
    this.fallbackResult = result;
  }

  setPreciseTapResult(result: TalkBackTapResult): void {
    this.preciseTapResult = result;
  }

  setLongPressResult(result: TalkBackTapResult): void {
    this.longPressResult = result;
  }

  queueTapResult(result: TalkBackTapResult): void {
    this.tapOverrides.push(result);
  }

  queueFallbackResult(result: TalkBackTapResult): void {
    this.fallbackOverrides.push(result);
  }

  queueLongPressResult(result: TalkBackTapResult): void {
    this.longPressOverrides.push(result);
  }

  async executeTap(
    deviceId: string,
    element: Element,
    _driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    this.tapCalls.push({ deviceId, element });

    if (this.tapOverrides.length > 0) {
      return this.tapOverrides.shift()!;
    }

    return this.tapResult;
  }

  async executeDirectActivation(
    element: Element,
    _driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    this.directActivationCalls.push({ element });

    if (this.directActivationOverrides.length > 0) {
      return this.directActivationOverrides.shift()!;
    }

    return this.directActivationResult;
  }

  async executeCoordinateFallback(
    x: number,
    y: number,
    action: TalkBackFallbackAction,
    durationMs: number,
    _driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    this.fallbackCalls.push({ x, y, action, durationMs });

    if (this.fallbackOverrides.length > 0) {
      return this.fallbackOverrides.shift()!;
    }

    return this.fallbackResult;
  }

  async executePreciseTap(
    x: number,
    y: number,
    _driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    this.preciseTapCalls.push({ x, y });
    return this.preciseTapResult;
  }

  async executeLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    _driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    this.longPressCalls.push({ x, y, durationMs, element });

    if (this.longPressOverrides.length > 0) {
      return this.longPressOverrides.shift()!;
    }

    return this.longPressResult;
  }
}
