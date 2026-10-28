import { recordObservationRead } from "./observationReadScope";
import { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import { logger } from "../../utils/logger";
import { BootedDevice, ObserveResult, requireAndroidOrIosPlatform } from "../../models";
import type { ObserveScreenshotOptions } from "./screenshot/screenshotOptions";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { attachPerfTimings, SingleDisplayStageContext, SingleDisplayRun } from "./singleDisplayRun";
import { SettledScreenshotCapture } from "./SettledScreenshotCapture";
import { attachObservePerfSnapshot } from "./observePerfSnapshot";
import { Timer } from "../../utils/SystemTimer";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import { PlatformObservationTraits } from "./collectors/PlatformObservationTraits";
import type { PerformanceAuditor } from "./audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "./audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import { SafeAreaAuditor } from "./audits/SafeAreaAuditor";
import type { ScreenRoundReader } from "../wear/screenRound";

/** Stages 3 and 5 of one single-display observation: derive elements, start screenshots, run audits and predictions, then attach timings and protect the screenshot. */
export interface SingleDisplayEnrichStageDependencies {
  device: () => BootedDevice;
  timer: () => Timer;
  platformTraits: () => PlatformObservationTraits;
  screenshotRecorder: () => ObserveScreenshotRecorder;
  pathProtection: () => ScreenshotPathProtection;
  performanceAuditor: () => Pick<PerformanceAuditor, "run">;
  accessibilityAuditor: () => Pick<AccessibilityAuditor, "run">;
  accessibilityStateDetector: () => Pick<AccessibilityStateDetector, "run">;
  predictiveUIState: () => PredictiveUIStateInterface;
  safeAreaAuditor: () => SafeAreaAuditor;
  elementsBuilder: () => ObserveElementsBuilder;
  screenRound: () => ScreenRoundReader;
  deferredBackStackDisplays: () => WeakMap<ObserveResult, number>;
  stampScreenSizeUnits: (result: ObserveResult) => void;
  processRecomposition: (result: ObserveResult, perf?: PerformanceTracker) => Promise<void>;
  captureSettledScreenshot: (
    ...args: Parameters<SettledScreenshotCapture["captureSettledScreenshot"]>
  ) => Promise<void>;
}

export class SingleDisplayEnrichStage {
  constructor(private readonly d: SingleDisplayEnrichStageDependencies) {}

  private enrichSingleDisplayElements(context: SingleDisplayStageContext): void {
    const { result } = context;

    // Hierarchy collection and accepted recaptures each replace `screenSize`.
    // Stamp its output-only unit marker after all of them, before the result is
    // cached, so every served and cached observation uses one platform source
    // of truth without changing the platform-native numeric coordinates.
    this.d.stampScreenSizeUnits(result);

    // Uncapped here; the output boundary (sanitizeObserveResult / the observe
    // served path in finalizeToolResponse) caps AFTER any scope narrowing so an
    // in-scope warning is never lost to a cap taken against the full tree (#5074).
    result.layoutWarnings = { scope: "full", warnings: this.d.safeAreaAuditor().inspect(result) };

    if (result.viewHierarchy) {
      result.elements = this.d
        .elementsBuilder()
        .build(
          result.viewHierarchy,
          requireAndroidOrIosPlatform(this.d.device().platform, "Observing the view hierarchy"),
        );
    }
  }
  /** Stage 3: derive elements, start screenshots, and run audits and predictions. */
  async enrichSingleDisplay(run: SingleDisplayRun): Promise<void> {
    this.enrichSingleDisplayElements({ result: run.result });
    await this.attachScreenRound(run);
    await this.startSingleDisplayScreenshot(run);
    await this.runSingleDisplayAudits(run);
  }

  /** Wear OS only (#14948): a phone pays no extra read and reports no field. */
  private async attachScreenRound(run: SingleDisplayRun): Promise<void> {
    if (this.d.device().formFactor !== "watch") {
      return;
    }
    const round = await this.d.screenRound().isScreenRound(run.signal);
    if (round !== undefined) {
      run.result.isScreenRound = round;
    }
  }

  private async startSingleDisplayScreenshot(run: SingleDisplayRun): Promise<void> {
    const { options, result, perf, signal, screenshotMode, requestedDisplayId } = run;
    // The hierarchy has completed before any capture starts.
    if (screenshotMode === "none") {
      result.screenshotCaptureAttempted = false;
      return;
    }
    const screenshotDisplayId = requestedDisplayId;
    const capture = prototypeCaptureOptions(options?.screenshotOptions);
    result.screenshotCaptureAttempted = true;
    stampPrototypeHidden(result, capture);
    if (screenshotMode === "settled") {
      result.screenshotOrientation = this.d.platformTraits().settledScreenshotOrientation();
      await this.d.captureSettledScreenshot(
        result,
        perf,
        signal,
        options?.screenshot === "settled",
        screenshotDisplayId,
        options?.screenshotOptions,
      );
    } else if (serverConfig.getAccessibilityAuditConfig()) {
      await this.d
        .screenshotRecorder()
        .capture(result.observationId, perf, signal, screenshotDisplayId, capture);
    } else {
      this.d
        .screenshotRecorder()
        .start(result.observationId, perf, signal, screenshotDisplayId, capture);
    }
  }

  private async runSingleDisplayAudits(run: SingleDisplayRun): Promise<void> {
    const { options, result, perf, signal, observerMode } = run;
    // Attach recomposition metrics if enabled.
    if (!options?.skipRecompositionTracking && !observerMode) {
      await this.d.processRecomposition(result, perf);
    }

    // Audits + accessibility state detection (each is config-gated; failures don't propagate)
    if (!options?.skipPerformanceAudit && !observerMode) {
      await this.d.performanceAuditor().run(result, perf);
    }
    if (!options?.skipAccessibilityAudit && !observerMode) {
      await this.d.accessibilityAuditor().run(result, perf);
    }
    if (!observerMode) {
      await this.d.accessibilityStateDetector().run(result, perf, signal);
    }

    if (!observerMode) {
      await this.attachPredictionsIfEnabled(result);
    }
  }

  /** Predictive UI (opt-in via config). */
  private async attachPredictionsIfEnabled(result: ObserveResult): Promise<void> {
    if (!serverConfig.isPredictiveUiEnabled()) {
      return;
    }
    try {
      const predictions = await this.d.predictiveUIState().generate(result, this.d.device());
      this.attachPredictions(result, predictions);
    } catch (error) {
      logger.warn(`[PredictiveUIState] Failed to generate predictions: ${error}`);
    }
  }
  /** Stage 5: attach timings, protect the screenshot and decide whether the read grants authority. */
  async publishSingleDisplay(run: SingleDisplayRun): Promise<ObserveResult> {
    const { result, perf, startTime, skipBackStack, observerMode } = run;
    perf.end();

    // Attach the windowed performance snapshot when opted in (independent of --debug-perf).
    if (!observerMode) {
      await attachObservePerfSnapshot(result, this.d.device(), this.d.timer());
    }
    attachPerfTimings(result, perf);

    if (result.screenshotPath) {
      result.screenshotExpiresAt = await this.d.pathProtection().protect(result.screenshotPath);
    }
    if (this.d.device().platform === "android" && !observerMode && skipBackStack) {
      this.d
        .deferredBackStackDisplays()
        .set(result, run.requestedDisplayId ?? run.observedAndroid?.logicalId ?? 0);
    }
    logger.debug("Observe command completed");
    logger.debug(`Total observe command execution took ${this.d.timer().now() - startTime}ms`);
    return this.d.platformTraits().grantsObservationRead(result)
      ? recordObservationRead(result)
      : result;
  }
  private attachPredictions(
    result: ObserveResult,
    predictions: ObserveResult["predictions"],
  ): void {
    if (predictions) {
      result.predictions = predictions;
    }
  }
}
/** The prototype-hiding part of an observe's screenshot options, for the non-settled captures. */
export function prototypeCaptureOptions(
  options: ObserveScreenshotOptions | undefined,
): { hidePrototypes: true } | undefined {
  return options?.hidePrototypes === true ? { hidePrototypes: true } : undefined;
}

/**
 * A capture requested with the prototype hidden either excludes it or produces no image (#9305), so
 * the observation is marked when the capture is requested; observe reports it for `layer: "app"`.
 */
export function stampPrototypeHidden(
  observation: ObserveResult,
  capture: { hidePrototypes: true } | undefined,
): void {
  if (capture) {
    observation.screenshotIncludesPrototype = false;
  } else {
    // A new capture without hiding replaces whatever an earlier capture of this object recorded.
    delete observation.screenshotIncludesPrototype;
  }
}
