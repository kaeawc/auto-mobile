import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";
import { SetUIStateOptions, FieldSpec, ElementSelector } from "../../models/SetUIStateOptions";
import { SetUIStateResult, FieldResult, FieldType } from "../../models/SetUIStateResult";
import { FieldTypeDetector } from "./FieldTypeDetector";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";

/**
 * Interface for TapOnElement dependency
 */
interface TapOnElementLike {
  execute(
    options: {
      text?: string;
      elementId?: string;
      action: string;
      container?: { text?: string; elementId?: string };
    },
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; element?: Element; observation?: ObserveResult; error?: string }>;
}

/**
 * Interface for InputText dependency
 */
interface InputTextLike {
  execute(
    text: string,
    imeAction?: string,
  ): Promise<{ success: boolean; text: string; observation?: ObserveResult; error?: string }>;
}

/**
 * Interface for ClearText dependency
 */
interface ClearTextLike {
  execute(
    progress?: ProgressCallback,
  ): Promise<{ success: boolean; observation?: ObserveResult; error?: string }>;
}

/**
 * Interface for SwipeOn dependency
 */
interface SwipeOnLike {
  execute(
    options: {
      direction: string;
      lookFor?: { text?: string; elementId?: string };
      scrollToFind?: boolean;
    },
    progress?: ProgressCallback,
  ): Promise<{
    success: boolean;
    found?: boolean;
    element?: Element;
    observation?: ObserveResult;
    error?: string;
  }>;
}

/**
 * Dependencies that can be injected for testing
 */
interface SetUIStateDependencies {
  tapOnElement?: TapOnElementLike;
  inputText?: InputTextLike;
  clearText?: ClearTextLike;
  swipeOn?: SwipeOnLike;
  observeScreen?: ObserveScreen;
  fieldTypeDetector?: FieldTypeDetector;
  timer?: Timer;
}

/**
 * Internal per-field outcome. Carries the fresh observation (if
 * verifyFieldValue already fetched one) alongside the public FieldResult so
 * execute() can reuse it instead of paying for a second, effectively
 * redundant observe against the device (#6222).
 */
interface InternalFieldResult extends FieldResult {
  freshObservation?: ObserveResult;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SCROLL_DIRECTION = "down";
const MAX_FUTILE_SCROLLS = 3;
/**
 * Wall-clock ceiling for the scroll search.
 *
 * Each futile scroll costs a swipe plus an observe against the device, and the
 * loop tries MAX_FUTILE_SCROLLS in each direction — roughly eight round trips,
 * which lands at about the caller's request timeout. The caller then sees a
 * transport timeout instead of this tool's own "Fields not found" error, which
 * points at the wrong thing (#4242). Stopping short of that keeps the actionable
 * error reachable.
 */
const SEARCH_BUDGET_MS = 20_000;

/**
 * Wall-clock ceiling for the WHOLE `execute()` call, measured from when it is
 * invoked. This is the safety net for issue #6222's reopen: PR #6237 made
 * per-field progress notifications extend the *transport's* request
 * deadline, but that extension only fires for a caller who set MCP's
 * `_meta.progressToken` -- the direct CLI->daemon path never does
 * (`runToolViaDaemon` in `src/cli/index.ts` calls `DaemonMcpProxy.callTool`
 * with no progressToken), so on that path the per-field progress plumbing is
 * entirely inert and a multi-field call that keeps applying fields
 * successfully still hits the transport's fixed deadline and gets its
 * accumulated `fields` results discarded by a bare `-32001` timeout.
 *
 * `SetUIState` cannot see or rely on the transport's actual deadline (it is
 * never threaded down through the tool handler), so it self-limits instead:
 * once this internal budget is spent, it stops starting new fields and
 * returns the accumulated per-field results as a normal (if
 * `success: false`) result -- never a silent discard -- while there is still
 * headroom before `DEFAULT_MCP_REQUEST_TIMEOUT_MS` (and the larger
 * `MIN_SET_UI_STATE_MCP_TIMEOUT_MS` floor added alongside this) can fire.
 * Deliberately smaller than both so this always wins the race.
 */
const RESULT_DEADLINE_BUDGET_MS = 45_000;

/**
 * SetUIState - Declarative form field population tool
 *
 * Populates form fields by specifying desired end-state rather than procedural steps.
 * Orchestrates existing tools (TapOnElement, InputText, ClearText, SwipeOn, ObserveScreen)
 * with automatic retry and verification.
 *
 * Fields are processed in screen order (top-to-bottom by bounds.top) as the form is scrolled,
 * regardless of the order provided by the caller.
 */
export class SetUIState extends BaseVisualChange {
  private fieldTypeDetector: FieldTypeDetector;
  private finder: ElementFinder;
  private dependencies: SetUIStateDependencies;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    dependencies: SetUIStateDependencies = {},
    finder: ElementFinder = new DefaultElementFinder(),
  ) {
    super(device, adb, dependencies.timer ?? defaultTimer);
    this.fieldTypeDetector = dependencies.fieldTypeDetector ?? new FieldTypeDetector();
    this.finder = finder;
    this.dependencies = dependencies;
  }

  /**
   * Execute the setUIState operation
   * @param options - Configuration options
   * @param progress - Optional progress callback
   * @param signal - Optional abort signal
   * @returns Result of the operation
   */
  async execute(
    options: SetUIStateOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SetUIStateResult> {
    const scrollDirection = options.scrollDirection ?? DEFAULT_SCROLL_DIRECTION;

    const fieldResults: FieldResult[] = new Array(options.fields.length);
    const processed = new Set<number>();
    let totalAttempts = 0;
    // See RESULT_DEADLINE_BUDGET_MS -- this is the whole-call safety net,
    // independent of (and in addition to) the search budget below.
    const resultDeadlineMs = this.timer.now() + RESULT_DEADLINE_BUDGET_MS;
    let resultBudgetSpent = false;

    // Progress reported to the client MUST stay on one consistent scale and
    // strictly increase -- MCP clients that enforce monotonicity reject or
    // ignore a repeated value, not just a decrease. Sub-steps a field's work
    // delegates to (TapOnElement, ClearText, ...) each independently report
    // their own local 0..100 range via the SAME callback (e.g. tap emits
    // 0,10 and then clear ALSO emits 0,10), which would otherwise collide or
    // reset mid-field or between fields. Give every field a fixed 100-wide
    // slice of one overall range (#6222 review).
    const FIELD_SLICE_WIDTH = 100;
    const overallProgressTotal = options.fields.length * FIELD_SLICE_WIDTH;
    let maxProgressReported = 0;
    // Emits the per-field boundary tick -- always the top of that field's
    // slice. This is always reachable: child-forwarded progress is capped
    // strictly below the slice endpoint (see fieldProgress below), so the
    // boundary value is guaranteed to exceed anything already emitted for
    // this field. The bump is a defensive floor, not the normal path.
    const emitProgress = async (raw: number, message?: string): Promise<void> => {
      if (!progress) {
        return;
      }
      const next = Math.min(Math.max(raw, maxProgressReported + 1), overallProgressTotal);
      maxProgressReported = next;
      await progress(next, overallProgressTotal, message);
    };
    // Projects a child step's own 0..N progress into the 100-wide slice for
    // the field currently being worked on (identified by how many fields are
    // already fully processed, i.e. its position in processing order). The
    // slice's own top value (fieldStart + 100) is RESERVED for the
    // field-boundary tick that follows -- a child reporting its own 100%
    // (e.g. childProgress===childTotal) is capped one below that endpoint, so
    // it can never tie or collide with the boundary tick. A child tick that
    // cannot land strictly above what has already been emitted is suppressed
    // outright rather than bumped: bumping here could push the value up to,
    // or past, the reserved endpoint -- or even into the next field's slice.
    const fieldProgress = (fieldSequence: number): ProgressCallback | undefined => {
      if (!progress) {
        return undefined;
      }
      const fieldStart = fieldSequence * FIELD_SLICE_WIDTH;
      const fieldSliceMax = fieldStart + FIELD_SLICE_WIDTH - 1;
      return async (childProgress, childTotal, message) => {
        const pct =
          childTotal && childTotal > 0 ? (childProgress / childTotal) * 100 : childProgress;
        const candidate = Math.min(fieldStart + pct, fieldSliceMax);
        if (candidate <= maxProgressReported) {
          // Cannot strictly increase without crossing into the boundary
          // tick's reserved endpoint or the next field's slice -- drop this
          // tick rather than violate either bound.
          return;
        }
        maxProgressReported = candidate;
        await progress(candidate, overallProgressTotal, message);
      };
    };

    // Get initial observation
    let lastObservation = await this.getObserveScreen().execute(
      undefined,
      undefined,
      false,
      0,
      signal,
    );

    let scrollsWithoutProgress = 0;
    let currentDirection: "up" | "down" = scrollDirection;
    let triedReverse = false;
    // Null until a search actually starts. Holding a rolling deadline instead
    // makes the budget sensitive to how long unrelated work took -- a slow
    // post-success observe would age it before the next search even began.
    let searchDeadline: number | null = null;
    let budgetSpent = false;

    while (processed.size < options.fields.length) {
      // Check the whole-call budget BEFORE starting another field's work --
      // give each field the same bounded budget it gets when it is the only
      // field in the call, then stop and return what has already been
      // applied rather than let the transport's own deadline discard it
      // (issue #6222 reopen).
      if (this.timer.now() >= resultDeadlineMs) {
        resultBudgetSpent = true;
        break;
      }

      // Find all unprocessed fields visible in the current hierarchy, sorted by bounds.top
      const visibleFields = this.findVisibleFieldsInScreenOrder(
        options.fields,
        processed,
        lastObservation?.viewHierarchy,
      );

      if (visibleFields.length > 0) {
        scrollsWithoutProgress = 0;

        // Process only the topmost visible field, then re-evaluate.
        // Each edit may change layout (keyboard, reflow, dynamic fields),
        // so we re-find visible fields from a fresh observation each iteration.
        const { fieldSpec, fieldIndex, element } = visibleFields[0];
        // This field's slice starts at processed.size * 100, before it is
        // added to `processed` below.
        const result = await this.processField(
          fieldSpec,
          element,
          fieldProgress(processed.size),
          signal,
        );

        processed.add(fieldIndex);
        // Retain only the small, public FieldResult fields across the loop --
        // `freshObservation` (a full view hierarchy) is used immediately below
        // for reuse and then must NOT be kept alive in `fieldResults` for the
        // rest of the call, or peak memory grows to fieldCount x one full
        // hierarchy instead of staying ~one hierarchy (#6222 review).
        fieldResults[fieldIndex] = this.toPublicFieldResult(result);
        totalAttempts += result.attempts;
        // Progress clears the budget: it bounds futile searching, not successful
        // work. The next search re-arms it from scratch (#4252 review).
        searchDeadline = null;

        // Report per-field advancement at the top of the field's own slice.
        // This keeps the request alive on progress-aware clients (a live
        // request timeout is commonly reset by progress notifications) and,
        // independent of transport behavior, gives the client a durable
        // trace of what has already been applied before a bare timeout could
        // otherwise leave it blind (#6222).
        await emitProgress(
          processed.size * 100,
          result.success
            ? `Set field ${this.describeSelector(fieldSpec.selector)} (${processed.size}/${options.fields.length})`
            : `Failed field ${this.describeSelector(fieldSpec.selector)} (${processed.size}/${options.fields.length})`,
        );

        // Refresh observation after each success. processField already fetched
        // a fresh observation as part of verification for most field types —
        // reuse it instead of paying for a second, effectively redundant
        // observe against the device, which is exactly the per-field cost that
        // was pushing multi-field calls past the request timeout (#6222).
        if (result.success) {
          lastObservation = await this.observationAfterSuccess(result, signal);
        }

        // Fail fast on failure
        if (!result.success) {
          logger.warn(
            `[SetUIState] Field failed, stopping: ${this.describeSelector(fieldSpec.selector)}`,
          );
          return {
            success: false,
            fields: this.collectResults(fieldResults, options.fields, processed),
            totalAttempts,
            observation: lastObservation,
            error:
              result.error ?? `Failed to set field: ${this.describeSelector(fieldSpec.selector)}`,
          };
        }
      } else {
        // No visible matches — scroll to find more.
        // Arm the budget on entering the search; only elapsed *search* time counts.
        if (searchDeadline === null) {
          searchDeadline = this.timer.now() + SEARCH_BUDGET_MS;
        } else if (this.timer.now() >= searchDeadline) {
          budgetSpent = true;
          break;
        }

        scrollsWithoutProgress++;

        if (scrollsWithoutProgress > MAX_FUTILE_SCROLLS) {
          if (!triedReverse) {
            // Try reverse direction
            currentDirection = currentDirection === "down" ? "up" : "down";
            triedReverse = true;
            scrollsWithoutProgress = 0;
          } else {
            // Exhausted both directions
            break;
          }
        }

        // Scroll one step without lookFor to avoid jumping past intermediate fields.
        // Using lookFor would enable scroll-until-visible mode which can skip over
        // fields that need to be processed first in screen order. The scroll is in
        // service of the next not-yet-processed field, so it reports into that
        // field's own progress slice (#6222 review).
        await this.getSwipeOn().execute(
          { direction: currentDirection },
          fieldProgress(processed.size),
        );

        // Re-observe after scroll
        const freshObs = await this.getObserveScreen().execute(
          undefined,
          undefined,
          false,
          0,
          signal,
        );
        if (freshObs) {
          lastObservation = freshObs;
        }
      }
    }

    // Check for any unprocessed fields
    if (processed.size < options.fields.length) {
      const missing = options.fields
        .filter((_, i) => !processed.has(i))
        .map((f) => this.describeSelector(f.selector));

      // The result-deadline case is NOT "not found" -- these fields may well
      // be on screen, they were simply never reached. Say so distinctly and
      // mark them `notAttempted` so a client can tell "safe to retry just
      // these" apart from "attempted and failed" (issue #6222 reopen).
      const notAttemptedReason = resultBudgetSpent
        ? `Not attempted: setUIState's internal result deadline (${Math.round(RESULT_DEADLINE_BUDGET_MS / 1000)}s) was reached after applying ${processed.size}/${options.fields.length} field(s)`
        : undefined;

      return {
        success: false,
        fields: this.collectResults(fieldResults, options.fields, processed, notAttemptedReason),
        totalAttempts,
        observation: lastObservation,
        error: resultBudgetSpent
          ? `setUIState result deadline (${Math.round(RESULT_DEADLINE_BUDGET_MS / 1000)}s) reached after applying ${processed.size}/${options.fields.length} field(s); not attempted: ${missing.join(", ")}`
          : budgetSpent
            ? `Fields not found within the ${Math.round(SEARCH_BUDGET_MS / 1000)}s search budget: ${missing.join(", ")}`
            : `Fields not found after scrolling: ${missing.join(", ")}`,
      };
    }

    return {
      success: true,
      fields: fieldResults,
      totalAttempts,
      observation: lastObservation,
    };
  }

  /**
   * Strip the internal `freshObservation` (a full view hierarchy) from a
   * field outcome before it is retained in `fieldResults` for the rest of the
   * call. The observation is only needed transiently, to let the caller reuse
   * it in place of an extra observe -- keeping it in the retained array would
   * hold one full hierarchy per verified field alive for the whole call
   * instead of ~one at a time (#6222 review).
   */
  private toPublicFieldResult(result: InternalFieldResult): FieldResult {
    return {
      selector: result.selector,
      success: result.success,
      attempts: result.attempts,
      verified: result.verified,
      error: result.error,
      fieldType: result.fieldType,
      skipped: result.skipped,
    };
  }

  /**
   * Observation to use as the "current state" after a field succeeded. Reuses
   * the fresh observation processField already fetched during verification
   * when one is available, avoiding a second observe against the device for
   * the same state (#6222).
   */
  private async observationAfterSuccess(
    result: InternalFieldResult,
    signal?: AbortSignal,
  ): Promise<ObserveResult> {
    if (result.freshObservation) {
      return result.freshObservation;
    }
    return this.getObserveScreen().execute(undefined, undefined, false, 0, signal);
  }

  /**
   * Find all unprocessed fields visible in the current hierarchy, sorted by bounds.top ascending
   */
  private findVisibleFieldsInScreenOrder(
    fields: FieldSpec[],
    processed: Set<number>,
    viewHierarchy?: ViewHierarchyResult,
  ): Array<{ fieldSpec: FieldSpec; fieldIndex: number; element: Element }> {
    const matches: Array<{ fieldSpec: FieldSpec; fieldIndex: number; element: Element }> = [];

    for (let i = 0; i < fields.length; i++) {
      if (processed.has(i)) {
        continue;
      }

      const element = this.findElement(fields[i].selector, viewHierarchy);
      if (element) {
        matches.push({ fieldSpec: fields[i], fieldIndex: i, element });
      }
    }

    // Sort by bounds.top ascending (screen order)
    matches.sort((a, b) => a.element.bounds.top - b.element.bounds.top);

    return matches;
  }

  /**
   * Collect results array, filling in empty slots for unprocessed fields
   */
  private collectResults(
    results: FieldResult[],
    fields: FieldSpec[],
    processed: Set<number>,
    notAttemptedReason?: string,
  ): FieldResult[] {
    const out: FieldResult[] = [];
    for (let i = 0; i < fields.length; i++) {
      if (processed.has(i) && results[i]) {
        out.push(results[i]);
      } else if (notAttemptedReason !== undefined) {
        out.push({
          selector: fields[i].selector,
          success: false,
          attempts: 0,
          notAttempted: true,
          error: notAttemptedReason,
        });
      } else {
        out.push({
          selector: fields[i].selector,
          success: false,
          attempts: 0,
          error: `Element not found: ${this.describeSelector(fields[i].selector)}`,
        });
      }
    }
    return out;
  }

  /**
   * Process a single field that has already been found
   */
  private async processField(
    fieldSpec: FieldSpec,
    initialElement: Element,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<InternalFieldResult> {
    let attempts = 0;
    let lastError: string | undefined;
    let fieldType: FieldType | undefined;
    let element = initialElement;

    while (attempts < DEFAULT_MAX_RETRIES) {
      attempts++;

      try {
        // On retry, re-find the element via scroll
        if (attempts > 1) {
          const freshObs = await this.getObserveScreen().execute(
            undefined,
            undefined,
            false,
            0,
            signal,
          );
          const found = freshObs?.viewHierarchy
            ? this.findElement(fieldSpec.selector, freshObs.viewHierarchy)
            : null;
          if (found) {
            element = found;
          }
        }

        // Detect field type
        fieldType = this.fieldTypeDetector.detect(element);
        logger.info(
          `[SetUIState] Field type detected: ${fieldType} for ${this.describeSelector(fieldSpec.selector)}`,
        );

        // Check if field already has correct value
        const alreadyCorrect = this.isFieldAlreadyCorrect(element, fieldSpec, fieldType);
        if (alreadyCorrect) {
          logger.info(`[SetUIState] Field already has correct value, skipping`);
          return {
            selector: fieldSpec.selector,
            success: true,
            attempts,
            verified: true,
            fieldType,
            skipped: true,
          };
        }

        // Apply the value based on field type
        const applyResult = await this.applyFieldValue(
          element,
          fieldSpec,
          fieldType,
          progress,
          signal,
        );

        // Retrying cannot reclassify an element that is not an editable field --
        // the type comes from the element itself, so the remaining attempts would
        // fail identically and only cost round trips (#4242).
        if (!applyResult.success && applyResult.unclassifiable) {
          lastError = applyResult.error;
          break;
        }

        if (!applyResult.success) {
          lastError = applyResult.error;
          continue;
        }

        // Skip verification when:
        // - Password field (value is masked)
        // - iOS element without value attribute
        // - Text-only selector on a mutable field type (typing replaces the label text
        //   used as the selector, so re-lookup by original text fails)
        let verified: boolean | undefined;
        let freshObservation: ObserveResult | undefined;
        const hasTextOnlySelector =
          fieldSpec.selector.text !== undefined && fieldSpec.selector.elementId === undefined;
        const isMutableTextField = fieldType === "text" || fieldType === "dropdown";
        const shouldSkipVerify =
          this.fieldTypeDetector.isPasswordField(element) ||
          this.fieldTypeDetector.shouldSkipVerification(element, fieldType) ||
          (hasTextOnlySelector && isMutableTextField);
        if (!shouldSkipVerify) {
          const verifyResult = await this.verifyFieldValue(fieldSpec, fieldType, signal);
          verified = verifyResult.verified;
          freshObservation = verifyResult.observation;
          if (!verified) {
            lastError = `Verification failed for ${this.describeSelector(fieldSpec.selector)}`;
            continue;
          }
        }

        return {
          selector: fieldSpec.selector,
          success: true,
          attempts,
          verified,
          fieldType,
          freshObservation,
        };
      } catch (error) {
        lastError = errorMessage(error);
        logger.warn(`[SetUIState] Attempt ${attempts} failed: ${lastError}`);
      }
    }

    return {
      selector: fieldSpec.selector,
      success: false,
      attempts,
      error: lastError,
      fieldType,
    };
  }

  /**
   * Find element in view hierarchy
   */
  private findElement(
    selector: ElementSelector,
    viewHierarchy?: ViewHierarchyResult,
  ): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    if (selector.text) {
      return this.finder.findElementByText(viewHierarchy, selector.text, undefined, true, false);
    }

    if (selector.elementId) {
      return this.finder.findElementByResourceId(viewHierarchy, selector.elementId);
    }

    return null;
  }

  /**
   * Check if field already has the correct value
   */
  private isFieldAlreadyCorrect(
    element: Element,
    fieldSpec: FieldSpec,
    fieldType: FieldType,
  ): boolean {
    switch (fieldType) {
      case "text":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.fieldTypeDetector.getTextValue(element);
          return currentValue === fieldSpec.value;
        }
        return false;

      case "checkbox":
      case "toggle":
        if (fieldSpec.selected !== undefined) {
          const isChecked = this.fieldTypeDetector.isChecked(element);
          return isChecked === fieldSpec.selected;
        }
        return false;

      case "dropdown":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.fieldTypeDetector.getTextValue(element);
          return currentValue === fieldSpec.value;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Apply value to field based on type
   */
  private async applyFieldValue(
    element: Element,
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; unclassifiable?: boolean }> {
    const tapOnElement = this.getTapOnElement();
    const inputText = this.getInputText();
    const clearText = this.getClearText();

    try {
      switch (fieldType) {
        case "text": {
          if (fieldSpec.value === undefined) {
            return { success: false, error: "value is required for text fields" };
          }

          const selectorDesc = this.describeSelector(fieldSpec.selector);

          // Tap to focus
          logger.debug(`[SetUIState] text.tap selector=${selectorDesc}`);
          const tapStart = Date.now();
          const tapResult = await tapOnElement.execute(
            this.buildTapOptions(fieldSpec.selector, "tap"),
            progress,
            signal,
          );
          logger.debug(
            `[SetUIState] text.tap done selector=${selectorDesc} success=${tapResult.success} totalMs=${Date.now() - tapStart}${tapResult.error ? ` error=${tapResult.error}` : ""}`,
          );
          if (!tapResult.success) {
            return { success: false, error: `Failed to tap on field: ${tapResult.error}` };
          }

          // Clear existing text
          logger.debug(`[SetUIState] text.clear selector=${selectorDesc}`);
          const clearStart = Date.now();
          const clearResult = await clearText.execute(progress);
          logger.debug(
            `[SetUIState] text.clear done selector=${selectorDesc} success=${clearResult.success} totalMs=${Date.now() - clearStart}${clearResult.error ? ` error=${clearResult.error}` : ""}`,
          );
          if (!clearResult.success) {
            return { success: false, error: `Failed to clear text: ${clearResult.error}` };
          }

          // Input new text. Intentionally passes no mode so the shared
          // InputText.execute applies event-all marker auto-promotion here too
          // (a form field value containing a configured marker, e.g. an
          // @mention, is typed via eventAll). This is by design — the feature
          // is scoped to both inputText and setUIState text fields.
          logger.debug(
            `[SetUIState] text.input selector=${selectorDesc} textLength=${fieldSpec.value.length}`,
          );
          const inputStart = Date.now();
          const inputResult = await inputText.execute(fieldSpec.value);
          logger.debug(
            `[SetUIState] text.input done selector=${selectorDesc} success=${inputResult.success} totalMs=${Date.now() - inputStart}${inputResult.error ? ` error=${inputResult.error}` : ""}`,
          );
          if (!inputResult.success) {
            return { success: false, error: `Failed to input text: ${inputResult.error}` };
          }

          return { success: true };
        }

        case "checkbox":
        case "toggle": {
          if (fieldSpec.selected === undefined) {
            return { success: false, error: "selected is required for checkbox/toggle fields" };
          }

          // Check current state
          const isChecked = this.fieldTypeDetector.isChecked(element);

          // Only tap if state needs to change
          if (isChecked !== fieldSpec.selected) {
            const tapResult = await tapOnElement.execute(
              this.buildTapOptions(fieldSpec.selector, "tap"),
              progress,
              signal,
            );
            if (!tapResult.success) {
              return { success: false, error: `Failed to tap checkbox/toggle: ${tapResult.error}` };
            }
          }

          return { success: true };
        }

        case "dropdown": {
          if (fieldSpec.value === undefined) {
            return { success: false, error: "value is required for dropdown fields" };
          }

          // Tap to open dropdown
          const openResult = await tapOnElement.execute(
            this.buildTapOptions(fieldSpec.selector, "tap"),
            progress,
            signal,
          );
          if (!openResult.success) {
            return { success: false, error: `Failed to open dropdown: ${openResult.error}` };
          }

          // Wait a bit for dropdown to open
          await this.timer.sleep(200);

          // Tap on the desired value
          const selectResult = await tapOnElement.execute(
            { text: fieldSpec.value, action: "tap" },
            progress,
            signal,
          );
          if (!selectResult.success) {
            return {
              success: false,
              error: `Failed to select dropdown value: ${selectResult.error}`,
            };
          }

          return { success: true };
        }

        default:
          // Name what was actually matched: this is normally a label rather than
          // the input itself, and "Unknown field type: unknown" describes an
          // internal state the caller cannot act on (#4242).
          return {
            success: false,
            unclassifiable: true,
            error:
              `Cannot set ${this.describeSelector(fieldSpec.selector)}: matched an element that is not ` +
              `an editable field (detected type "${fieldType}"). Select the input rather than its label.`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: errorMessage(error),
      };
    }
  }

  /**
   * Verify field value after setting
   */
  private async verifyFieldValue(
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    signal?: AbortSignal,
  ): Promise<{ verified: boolean; observation?: ObserveResult }> {
    // Get fresh observation. The caller (processField -> execute) reuses this
    // as its own post-success refresh instead of issuing a second, effectively
    // redundant observe against the device (#6222).
    const observation = await this.getObserveScreen().execute(
      undefined,
      undefined,
      false,
      0,
      signal,
    );
    if (!observation?.viewHierarchy) {
      return { verified: false, observation };
    }

    // Find the element again
    const element = this.findElement(fieldSpec.selector, observation.viewHierarchy);
    if (!element) {
      return { verified: false, observation };
    }

    // Verify based on field type
    switch (fieldType) {
      case "text":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.fieldTypeDetector.getTextValue(element);
          return { verified: currentValue === fieldSpec.value, observation };
        }
        return { verified: true, observation };

      case "checkbox":
      case "toggle":
        if (fieldSpec.selected !== undefined) {
          const isChecked = this.fieldTypeDetector.isChecked(element);
          return { verified: isChecked === fieldSpec.selected, observation };
        }
        return { verified: true, observation };

      case "dropdown":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.fieldTypeDetector.getTextValue(element);
          return { verified: currentValue === fieldSpec.value, observation };
        }
        return { verified: true, observation };

      default:
        return { verified: true, observation };
    }
  }

  /**
   * Build tap options from selector
   */
  private buildTapOptions(
    selector: ElementSelector,
    action: string,
  ): { text?: string; elementId?: string; action: string } {
    if (selector.text) {
      return { text: selector.text, action };
    }
    return { elementId: selector.elementId, action };
  }

  /**
   * Describe a selector for error messages
   */
  private describeSelector(selector: ElementSelector): string {
    if (selector.text) {
      return `text="${selector.text}"`;
    }
    if (selector.elementId) {
      return `elementId="${selector.elementId}"`;
    }
    return "unknown selector";
  }

  // Dependency getters with lazy initialization

  private getTapOnElement(): TapOnElementLike {
    if (this.dependencies.tapOnElement) {
      return this.dependencies.tapOnElement;
    }
    // Lazy import to avoid circular dependencies
    const { TapOnElement } = require("./TapOnElement");
    return new TapOnElement(this.device, this.adb);
  }

  private getInputText(): InputTextLike {
    if (this.dependencies.inputText) {
      return this.dependencies.inputText;
    }
    const { InputText } = require("./InputText");
    return new InputText(this.device, this.adb);
  }

  private getClearText(): ClearTextLike {
    if (this.dependencies.clearText) {
      return this.dependencies.clearText;
    }
    const { ClearText } = require("./ClearText");
    return new ClearText(this.device, this.adb);
  }

  private getSwipeOn(): SwipeOnLike {
    if (this.dependencies.swipeOn) {
      return this.dependencies.swipeOn;
    }
    const { SwipeOn } = require("./swipeon");
    return new SwipeOn(this.device, this.adb);
  }

  private getObserveScreen(): ObserveScreen {
    if (this.dependencies.observeScreen) {
      return this.dependencies.observeScreen;
    }
    return this.observeScreen;
  }
}
