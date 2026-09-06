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
 * `setUIStateHandler` (`src/server/formTools.ts`) now recovers the ACTUAL
 * transport deadline when the call was daemon-forwarded (issue #6222 P1) and
 * passes it into `execute()` as `transportDeadlineMs`, in which case it --
 * minus `PER_FIELD_ADMISSION_HEADROOM_MS` -- takes over as the bound (see
 * `resultDeadlineMs` in `execute()`) instead of this fixed clock. This budget
 * remains the FALLBACK for a path with no known transport deadline (a direct,
 * non-daemon call): once it is spent, `execute()` stops starting new fields
 * and returns the accumulated per-field results as a normal (if
 * `success: false`) result -- never a silent discard -- while there is still
 * headroom before `DEFAULT_MCP_REQUEST_TIMEOUT_MS` (and the larger
 * `MIN_SET_UI_STATE_MCP_TIMEOUT_MS` floor added alongside the original fix)
 * can fire. Deliberately smaller than both so this always wins the race.
 */
const RESULT_DEADLINE_BUDGET_MS = 45_000;

/**
 * Headroom reserved before admitting the NEXT field once the caller's
 * `transportDeadlineMs` is known (issue #6222 P1). A field admitted with
 * almost no budget left can still run for a while after admission --
 * `applyFieldValue` (tap + clear + type, or open+select for a dropdown) plus
 * `verifyFieldValue`'s post-success observe -- and the dogfood report that
 * reopened #6222 showed a field admitted at 44s of a 60s transport deadline
 * running roughly 20s more, overrunning the transport and losing the whole
 * accumulated result to a bare `-32001`. Only admit another field while at
 * least this much of the transport budget remains; otherwise stop and return
 * the accumulated per-field results while there is still time for the
 * transport to deliver them.
 */
const PER_FIELD_ADMISSION_HEADROOM_MS = 20_000;

/**
 * Single source of truth for "how much headroom must remain before the live
 * deadline for a device-I/O await to be raced against it" (issue #6222 P1,
 * unifying the fujug/fujuk/fujun review round). The daemon's own outer abort
 * (the `controller` armed in `handleIdeRequest`, `src/daemon/socketServer.ts`
 * -- see `armAbort(timeoutMs)` / `armAbort(deadline.value - now)`) fires
 * EXACTLY at the live `ProgressExtendableDeadline`'s current value, with no
 * headroom of its own. A field or observe race that only stops "at" that
 * same instant is a coin flip against response serialization, not a
 * guarantee -- if the outer abort wins, the transport discards the whole
 * call before this file's structured (partial or complete) result can ever
 * be returned (fujug). Every cutoff this file races an await against is
 * therefore `liveDeadlineMs() - RESPONSE_HEADROOM_MS`, strictly BEFORE the
 * outer abort, so building and returning the result always has time to
 * finish first. Kept well above zero (the outer abort's own margin) so this
 * headroom is the thing that actually buys the safety margin.
 */
const RESPONSE_HEADROOM_MS = 3_000;

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
   * @param transportDeadlineMs - Absolute wall-clock deadline (same clock as
   *   `this.timer.now()`) of the CURRENT MCP request, when known. This is the
   *   real transport deadline the caller (`setUIStateHandler`) recovered from
   *   the daemon-forwarded request's own budget -- accounting for time
   *   already spent queued -- NOT a fresh clock started here. When provided,
   *   field admission is bounded by this deadline (minus
   *   `PER_FIELD_ADMISSION_HEADROOM_MS`) instead of only the internal
   *   `RESULT_DEADLINE_BUDGET_MS` clock, so a call never keeps admitting
   *   fields past the point the transport itself would discard the result
   *   (issue #6222 P1). Undefined on a direct/non-daemon call, where the
   *   internal budget alone is the only bound available. Superseded, on every
   *   check, by `getLiveTransportDeadlineMs()` when that is provided.
   * @param getLiveTransportDeadlineMs - Optional getter for the CURRENT value
   *   of the transport deadline, read fresh at every admission check instead
   *   of relying on the `transportDeadlineMs` snapshot above. A
   *   daemon-forwarded, progress-capable call's real deadline can be pushed
   *   FORWARD after `execute()` started (`ProgressExtendableDeadline`,
   *   extended as THIS call's own progress notifications reach the daemon) --
   *   `transportDeadlineMs` alone can never reflect that, since it is
   *   captured once before `execute()` is even invoked. When this getter
   *   returns `undefined` (e.g. the daemon-side entry was never registered,
   *   or the call is not daemon-forwarded), `transportDeadlineMs` is used
   *   as-is (issue #6222 P1 reopen, fuQ88 review).
   * @returns Result of the operation
   */
  async execute(
    options: SetUIStateOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    transportDeadlineMs?: number,
    getLiveTransportDeadlineMs?: () => number | undefined,
  ): Promise<SetUIStateResult> {
    const scrollDirection = options.scrollDirection ?? DEFAULT_SCROLL_DIRECTION;

    const fieldResults: FieldResult[] = new Array(options.fields.length);
    const processed = new Set<number>();
    let totalAttempts = 0;
    // See RESULT_DEADLINE_BUDGET_MS -- this is the whole-call safety net,
    // independent of (and in addition to) the search budget below.
    const callStartMs = this.timer.now();
    const internalResultDeadlineMs = callStartMs + RESULT_DEADLINE_BUDGET_MS;

    // Read fresh on every call, never cached: `getLiveTransportDeadlineMs`
    // (when provided) always wins over the frozen `transportDeadlineMs`
    // snapshot, since it is the CURRENT value of the same live object the
    // daemon itself extends on progress (issue #6222 P1 reopen, fuQ88
    // review). Falls back to the frozen snapshot when no live getter is
    // available, or it has nothing registered (e.g. the daemon-side entry
    // already expired).
    const currentTransportDeadlineMs = (): number | undefined =>
      getLiveTransportDeadlineMs?.() ?? transportDeadlineMs;

    // The bound that governs whether it is safe to ADMIT another field: when
    // the caller knows the ACTUAL transport deadline, that is always the
    // bound that matters -- respect it even when it is LARGER than the fixed
    // internal budget (e.g. a progress-aware caller whose
    // `ProgressExtendableDeadline` has extended the transport deadline toward
    // its ceiling). Clamping to the fixed 45s here would silently undo that
    // extension and under-cut a legitimately larger budget, which also
    // truncates `executePlan` steps that route through this same `execute()`
    // (issue #6222 P1). The fixed `RESULT_DEADLINE_BUDGET_MS` is a FALLBACK
    // for when no transport deadline is known at all (a direct, non-daemon
    // call) -- never a ceiling imposed on top of a known one. Reserving
    // `PER_FIELD_ADMISSION_HEADROOM_MS` here (only when a transport deadline
    // is actually known) accounts for the worst-case runtime of whatever
    // field is admitted next.
    const admissionDeadlineMs = (): number => {
      const liveTransportDeadlineMs = currentTransportDeadlineMs();
      return liveTransportDeadlineMs !== undefined
        ? liveTransportDeadlineMs - PER_FIELD_ADMISSION_HEADROOM_MS
        : internalResultDeadlineMs;
    };
    // Single source of truth for the live deadline: the CURRENT (possibly
    // progress-extended) transport deadline when known, else the fixed
    // internal fallback. Read fresh on every call -- never cached -- so a
    // `ProgressExtendableDeadline` extension that lands between two checks is
    // always visible (issue #6222 P1, fujuk).
    const liveDeadlineMs = (): number => currentTransportDeadlineMs() ?? internalResultDeadlineMs;
    // The cutoff EVERY device-I/O await in this file (the initial
    // observation and each admitted field) is raced against -- deliberately
    // `RESPONSE_HEADROOM_MS` BEFORE the live deadline, not AT it, so the
    // structured result this file builds always has time to be returned
    // ahead of the daemon's own outer abort, which fires exactly at the live
    // deadline with no headroom of its own (issue #6222 P1, fujug). This is
    // intentionally a SEPARATE, much smaller margin than
    // `PER_FIELD_ADMISSION_HEADROOM_MS` above: that headroom decides whether
    // it is worth STARTING another field at all; this one decides when an
    // ALREADY-STARTED await must be treated as stalled. An admitted field
    // that finishes within this cutoff must not be treated as a stall just
    // because it ran past the smaller admission-only bound above.
    const cutoffMs = (): number => liveDeadlineMs() - RESPONSE_HEADROOM_MS;
    // Only used to phrase "why we stopped" messages below -- the actual bound
    // applied is whichever of the internal/transport-derived deadlines is
    // tighter at the moment of the check, which may be smaller OR larger than
    // RESULT_DEADLINE_BUDGET_MS and can change between checks when a live
    // getter is in play.
    const admissionDeadlineBudgetMsForMessage = (): number => admissionDeadlineMs() - callStartMs;
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

    // Check the budget BEFORE paying for the initial observation, not just at
    // the top of the field loop below. Queueing on the daemon path can by
    // itself consume most of a 60s transport budget before `execute()` is
    // even invoked; if the admission deadline is already gone (or too tight
    // to admit even one field's headroom), a cold/stalled initial observe can
    // still blow the transport deadline before any field is attempted,
    // discarding the whole call. Fail fast into the same structured
    // all-`notAttempted` shape used below instead (issue #6222 P1).
    if (this.timer.now() >= admissionDeadlineMs()) {
      const missing = options.fields.map((f) => this.describeSelector(f.selector));
      const notAttemptedReason = `Not attempted: setUIState's result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) was already reached before the initial observation`;
      return {
        success: false,
        fields: this.collectResults(fieldResults, options.fields, processed, notAttemptedReason),
        totalAttempts: 0,
        error: `setUIState result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) was already reached before the initial observation; not attempted: ${missing.join(", ")}`,
      };
    }

    // Get initial observation -- RACED against `cutoffMs()`, not merely
    // preceded by the admission check above (issue #6222 P1, fujun). Queueing
    // can leave slightly more than `PER_FIELD_ADMISSION_HEADROOM_MS` of
    // budget, passing the check above, and a cold or stalled observation can
    // still overrun the transport deadline if simply awaited unbounded. This
    // is a safety net, not real cancellation: `ObserveScreen` cannot
    // currently be cancelled, so a timed-out observe is left running in the
    // background (see `raceAgainstDeadline`) and this call returns the same
    // structured all-`notAttempted` shape used by the admission check above.
    const initialObservationRaced = await this.raceAgainstDeadline(
      () => this.getObserveScreen().execute(undefined, undefined, false, 0, signal),
      () => cutoffMs(),
      "initial observation",
    );
    if (initialObservationRaced === "timed-out") {
      const missing = options.fields.map((f) => this.describeSelector(f.selector));
      const notAttemptedReason = `Not attempted: setUIState's initial observation did not settle within setUIState's result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s)`;
      return {
        success: false,
        fields: this.collectResults(fieldResults, options.fields, processed, notAttemptedReason),
        totalAttempts: 0,
        error: `setUIState's initial observation did not settle within the result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s); not attempted: ${missing.join(", ")}`,
      };
    }
    let lastObservation = initialObservationRaced;

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
      if (this.timer.now() >= admissionDeadlineMs()) {
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
        // added to `processed` below. `fieldBudgetMs` here is only a snapshot
        // for the timeout message below -- the race itself re-reads
        // `cutoffMs()` live, both at admission and again on every progress
        // tick via `onTick` (issue #6222 P1, fujuk): a mid-field progress
        // notification that extends the live transport deadline re-arms this
        // SAME field's own timeout against the new, larger budget instead of
        // timing out against the stale value captured here.
        const fieldBudgetMs = cutoffMs() - this.timer.now();
        const raced = await this.raceAgainstDeadline<InternalFieldResult>(
          (onTick) =>
            this.processField(
              fieldSpec,
              element,
              this.withRearmOnTick(fieldProgress(processed.size), onTick),
              signal,
            ),
          () => cutoffMs(),
          this.describeSelector(fieldSpec.selector),
        ).catch((error: unknown): InternalFieldResult => ({
          selector: fieldSpec.selector,
          success: false,
          attempts: 0,
          error: errorMessage(error),
        }));

        processed.add(fieldIndex);

        if (raced === "timed-out") {
          // The field WAS admitted and started but did not settle within its
          // remaining share of the real transport deadline -- `processField`
          // (and the `ClearTextLike`/`InputTextLike` it delegates into)
          // cannot currently be cancelled, so this is a safety net rather
          // than real cancellation: the underlying call may still be running
          // against the device, its eventual outcome no longer awaited or
          // reported. Stop immediately and return the accumulated partial
          // result instead of risking the SAME overrun this whole feature
          // exists to prevent (issue #6222 review, coderabbit fuTtO).
          fieldResults[fieldIndex] = {
            selector: fieldSpec.selector,
            success: false,
            attempts: 0,
            timedOut: true,
            error: `Field ${this.describeSelector(fieldSpec.selector)} did not settle within its ${Math.round(Math.max(fieldBudgetMs, 0) / 1000)}s share of setUIState's result deadline; it may still be applying in the background`,
          };
          resultBudgetSpent = true;
          break;
        }

        const result = raced;
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
          // The field itself already succeeded and is recorded in
          // `fieldResults` above -- only the follow-up observation used to
          // locate the NEXT field is at risk here. Without a
          // `freshObservation`, `observationAfterSuccess`'s fallback issues
          // an UNBOUNDED `ObserveScreen.execute()`; if that stalls, awaiting
          // it directly would let the daemon's outer transport deadline win
          // and discard everything already applied -- exactly the failure
          // mode this whole feature exists to prevent. Race it against the
          // SAME live cutoff every other device call in this method already
          // respects (issue #6222 review, PRRT_kwDOP-GF5M6fu4ev).
          const observationRaced = await this.raceAgainstDeadline<ObserveResult>(
            () => this.observationAfterSuccess(result, signal),
            () => cutoffMs(),
            "post-success observation refresh",
          );

          if (observationRaced === "timed-out") {
            logger.warn(
              `[SetUIState] Post-success observation refresh stalled after field ${this.describeSelector(fieldSpec.selector)}; returning ${processed.size}/${options.fields.length} accumulated field result(s) without a fresh observation`,
            );
            const notAttemptedReason =
              processed.size < options.fields.length
                ? `Not attempted: setUIState's post-success observation refresh stalled after applying ${processed.size}/${options.fields.length} field(s)`
                : undefined;
            return {
              success: false,
              fields: this.collectResults(
                fieldResults,
                options.fields,
                processed,
                notAttemptedReason,
              ),
              totalAttempts,
              // Keep whatever observation is already on hand (from the
              // PREVIOUS successful field, or the initial observation)
              // rather than blocking on the unbounded refresh -- omitted
              // only when no observation was ever captured.
              observation: lastObservation,
              error: `setUIState's post-success observation refresh did not settle within the result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) after applying ${processed.size}/${options.fields.length} field(s); the applied field(s) succeeded but the refreshed observation is unavailable`,
            };
          }

          lastObservation = observationRaced;
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
        //
        // Both the swipe and the follow-up re-observe are UNBOUNDED device
        // I/O -- if either stalls, the daemon's outer abort fires first and
        // discards the accumulated structured result built up so far,
        // exactly the failure mode this whole feature exists to prevent.
        // Race the whole iteration against the same live cutoff every other
        // device call in this method already respects (issue #6222 review,
        // PRRT_kwDOP-GF5M6fuyts): a stall here stops the search and returns
        // what has already been applied instead of letting the outer abort
        // discard it.
        const searchRaced = await this.raceAgainstDeadline<ObserveResult | undefined>(
          async (onTick) => {
            await this.getSwipeOn().execute(
              { direction: currentDirection },
              this.withRearmOnTick(fieldProgress(processed.size), onTick),
            );

            // Re-observe after scroll
            return this.getObserveScreen().execute(undefined, undefined, false, 0, signal);
          },
          () => cutoffMs(),
          "off-screen search (swipe + re-observe)",
        );

        if (searchRaced === "timed-out") {
          resultBudgetSpent = true;
          break;
        }

        if (searchRaced) {
          lastObservation = searchRaced;
        }
      }
    }

    // Check for any unprocessed fields -- or a per-field timeout on the LAST
    // admitted field (issue #6222 review, coderabbit fuTtO): that field IS in
    // `processed` (it was admitted and started) but did not succeed, so
    // `processed.size === options.fields.length` alone would otherwise fall
    // through to the unconditional success return below despite the timeout.
    if (processed.size < options.fields.length || resultBudgetSpent) {
      const missing = options.fields
        .filter((_, i) => !processed.has(i))
        .map((f) => this.describeSelector(f.selector));

      // The result-deadline case is NOT "not found" -- these fields may well
      // be on screen, they were simply never reached. Say so distinctly and
      // mark them `notAttempted` so a client can tell "safe to retry just
      // these" apart from "attempted and failed" (issue #6222 reopen).
      const notAttemptedReason = resultBudgetSpent
        ? `Not attempted: setUIState's result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) was reached after applying ${processed.size}/${options.fields.length} field(s)`
        : undefined;

      return {
        success: false,
        fields: this.collectResults(fieldResults, options.fields, processed, notAttemptedReason),
        totalAttempts,
        observation: lastObservation,
        error: resultBudgetSpent
          ? missing.length > 0
            ? `setUIState result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) reached after applying ${processed.size}/${options.fields.length} field(s); not attempted: ${missing.join(", ")}`
            : `setUIState result deadline (${Math.round(admissionDeadlineBudgetMsForMessage() / 1000)}s) reached while applying field(s); the last-admitted field did not settle in time`
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
   * Wraps a field's progress callback so every tick that reaches it also
   * calls `onTick` -- the hook `raceAgainstDeadline` uses to re-arm an
   * in-flight race's timeout against the LIVE cutoff (issue #6222 P1,
   * fujuk). A progress notification is the only thing that can move a
   * `ProgressExtendableDeadline` forward (`extendOnProgress`,
   * `src/daemon/socketServer.ts`), so re-checking exactly when one is
   * forwarded -- rather than only once at field admission -- is what lets a
   * mid-field extension apply to THIS SAME field's own remaining budget
   * instead of only to fields admitted afterward. A no-op (returns
   * `undefined`) when there is no inner callback to wrap, matching
   * `fieldProgress`'s own contract.
   */
  private withRearmOnTick(
    inner: ProgressCallback | undefined,
    onTick: () => void,
  ): ProgressCallback | undefined {
    if (!inner) {
      return undefined;
    }
    return async (childProgress, childTotal, message) => {
      await inner(childProgress, childTotal, message);
      onTick();
    };
  }

  /**
   * Race a unit of device I/O against a live-read cutoff (issue #6222 P1,
   * unifying fujug/fujuk/fujun). Used for both the initial observation and
   * each admitted field's `processField()` call. Neither can currently be
   * cancelled -- without this, either can run past the transport deadline
   * and reproduce the exact silent-discard this whole feature exists to
   * prevent, even though it was correctly started under budget at the time.
   *
   * This is a SAFETY NET, not real cancellation: the started call is left
   * running in the background when the timeout wins the race -- its eventual
   * settlement is swallowed (only logged) rather than aborted. Real
   * cancellation via an `AbortSignal` into `ClearText`/`InputText`/
   * `ObserveScreen` is a larger, separate change; tracked as a follow-up
   * rather than attempted here.
   *
   * Takes a THUNK, not an already-started promise: `startWork()` must not be
   * called until AFTER the timeout is armed. Its own dependencies can run
   * synchronously far enough to matter (fakes in tests advance a shared
   * clock synchronously; real device I/O at least burns real wall-clock time
   * before its first genuine suspension) -- starting it as part of
   * evaluating this method's arguments, before its body runs, would arm the
   * timeout against a clock that already moved, silently shrinking the
   * work's actual budget.
   *
   * `getCutoffMs` is read fresh both when the timeout is (re-)armed here and
   * again every time `startWork`'s own `onTick` hook fires (see
   * `withRearmOnTick`) -- so a live-extended deadline applies to an
   * ALREADY-RUNNING race, not just to work started afterward (fujuk). A
   * cutoff at or before now re-arms as an IMMEDIATE timeout rather than a
   * no-op, so an extension that shrinks the effective remaining time (e.g.
   * the live deadline did not move) still resolves promptly.
   *
   * @param startWork - Starts the work. Invoked exactly once, after the
   *   timeout below is first armed. Receives `onTick`, to be invoked
   *   whenever the caller learns the live cutoff may have moved.
   * @param getCutoffMs - Returns the CURRENT absolute cutoff (already
   *   headroom-adjusted, e.g. `cutoffMs()`) this race must finish before.
   *   Read fresh on every (re-)arm, never cached.
   * @param describeWork - Only used to identify the work in a debug log if
   *   its promise eventually settles after the race already timed out.
   * @returns The work's real result if it settles in time, or the literal
   *   string `"timed-out"` if the timeout wins the race.
   */
  private async raceAgainstDeadline<T>(
    startWork: (onTick: () => void) => Promise<T>,
    getCutoffMs: () => number,
    describeWork: string,
  ): Promise<T | "timed-out"> {
    // A background settlement after abandonment has no observer left to
    // report to beyond this debug trace -- expected once the work's own
    // budget has already been spent.
    const logBackgroundSettlement = (workPromise: Promise<T>): void => {
      workPromise
        .then(() => {
          logger.debug(`[SetUIState] Background work settled after timeout for ${describeWork}`);
        })
        .catch((error: unknown) => {
          logger.debug(
            `[SetUIState] Background work rejected after timeout for ${describeWork}: ${errorMessage(error)}`,
          );
        });
    };

    return new Promise<T | "timed-out">((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      // Declared (not yet assigned) BEFORE the first arm: on a
      // FakeTimer-driven test, `startWork()`'s own synchronous prefix can
      // advance the clock far enough to fire the timeout re-entrantly,
      // synchronously, before `startWork()` even returns -- at which point
      // this closure has not yet been assigned. `let` (rather than `const`)
      // avoids a TDZ crash in that case: a bare `let x;` initializes its
      // binding to `undefined` immediately at THIS line, so the timeout
      // closure below can safely read it even if it fires before the
      // assignment further down ever runs. The guard below skips tracing
      // when it is still `undefined`, and the post-`startWork()` check a few
      // lines down handles that case instead.
      // oxlint-disable-next-line prefer-const -- see comment above: `let` is required for TDZ safety, not a style preference.
      let workPromise: Promise<T> | undefined;

      const finishTimedOut = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle !== undefined) {
          this.timer.clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (workPromise) {
          logBackgroundSettlement(workPromise);
        }
        resolve("timed-out");
      };

      // (Re-)arms the timeout against a FRESHLY read cutoff. A non-positive
      // remaining budget still resolves "timed-out" immediately rather than
      // arming a timer for it.
      const armTimeout = (): void => {
        if (settled) {
          return;
        }
        if (timeoutHandle !== undefined) {
          this.timer.clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        const budgetMs = getCutoffMs() - this.timer.now();
        if (budgetMs <= 0) {
          finishTimedOut();
          return;
        }
        timeoutHandle = this.timer.setTimeout(finishTimedOut, budgetMs);
      };

      // Passed to `startWork` as `onTick`: re-arms against the live cutoff
      // whenever the caller learns it may have moved (issue #6222 P1,
      // fujuk). A no-op once already settled.
      const onTick = (): void => {
        armTimeout();
      };

      armTimeout();
      // Armed above; only now does the work actually start.
      workPromise = startWork(onTick);
      const startedWorkPromise = workPromise;
      if (settled) {
        // The timeout above already fired (synchronously, budget<=0, or
        // re-entrantly while `startWork()` was still running synchronously)
        // before this closure could observe it via `workPromise` -- trace
        // its eventual settlement here instead.
        logBackgroundSettlement(startedWorkPromise);
        return;
      }
      startedWorkPromise.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutHandle !== undefined) {
            this.timer.clearTimeout(timeoutHandle);
          }
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutHandle !== undefined) {
            this.timer.clearTimeout(timeoutHandle);
          }
          // The known callers (`processField`, `ObserveScreen.execute`)
          // resolve rather than reject in practice -- this is a defensive
          // fallback for something truly unexpected. Propagated to the
          // caller rather than swallowed here, since only the caller knows
          // how to shape a failure specific to what it was racing.
          reject(error);
        },
      );
    });
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
