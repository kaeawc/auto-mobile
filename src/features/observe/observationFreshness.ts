/**
 * Observation freshness — the single definition of "does this tree match the screen?".
 *
 * Shared by `ObserveScreen` (which reports the verdict) and the per-platform
 * hierarchy delegates (which decide whether a cached tree may be served without
 * re-verification), so the two can never disagree: the only way to be over the
 * age budget in a report is for a forced re-verification to have failed or been
 * impossible.
 *
 * Background. `freshness.isFresh` used to be the literal `true` whenever the
 * caller supplied no `minTimestamp` — which is every plain `observe` call, since
 * `minTimestamp` is not reachable from the public tool schema. It therefore
 * measured nothing on the only path most consumers take, while the host-side
 * hierarchy cache could serve a tree that was minutes old under that label.
 */

/**
 * How old a captured tree may be before it must be re-verified against the
 * device rather than served from cache.
 *
 * Rationale for the default: the iOS runner's `HierarchyDebouncer` polls at
 * 1000ms and only broadcasts on a structural-hash CHANGE, so an unchanging (or
 * wedged) screen produces no pushes at all and leaves the host cache frozen at
 * its last capture. A budget a few poll intervals wide distinguishes "nothing
 * pushed because nothing changed" from "nothing pushed because the channel is
 * dead" without flapping. It is deliberately NOT tied to extraction cost:
 * `updatedAt` is stamped when the hierarchy object is constructed (i.e. at the
 * END of extraction), so even an 11-second dense-screen snapshot arrives with an
 * age near zero.
 */
export const DEFAULT_MAX_OBSERVATION_AGE_MS = 5000;

/** Env override, for hosts whose runner is slower or whose budget is tighter. */
export function maxObservationAgeMs(): number {
  const raw = process.env["AUTOMOBILE_MAX_OBSERVATION_AGE_MS"];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_OBSERVATION_AGE_MS;
}

export interface FreshnessInputs {
  /** `minTimestamp` the caller asked to be satisfied, if any. */
  requestedAfter?: number;
  /** The capture timestamp carried by the observation itself. */
  actualTimestamp?: number;
  /**
   * A host-clock-domain timestamp to measure {@link FreshnessVerdict.ageMs}
   * against, when the source can supply one (e.g. the Android delegate's
   * host-side receipt time). `actualTimestamp` is device-authored, so on an
   * emulator whose clock is skewed from the host, `now - actualTimestamp` reports
   * the skew as age (issue #5377). When present, age is computed from this
   * host-domain basis instead; when absent (iOS, which shares the host clock),
   * age falls back to `actualTimestamp` and behavior is unchanged.
   */
  hostAgeBasisMs?: number;
  /** Wall clock at report time. */
  now: number;
  /**
   * Did the delegate obtain a tree it verified against the device on THIS call,
   * as opposed to serving a host-side cache entry unverified? `undefined` when
   * the source cannot report it (no delegate plumbing on that platform yet).
   */
  verified?: boolean;
  /** The hierarchy could not be retrieved, so no freshness verdict is possible. */
  unavailable?: boolean;
  /**
   * The observed hierarchy's window identity does not match the device's current
   * top resumed activity — the tree is a stale wrong-window capture (issue
   * #5867). `observed` is the app the hierarchy was captured from; `foreground`
   * is the app actually resumed on the device. When set, freshness is retracted
   * unconditionally: `verified: false`, `isFresh: false`, regardless of age or
   * the delegate's own `verified` signal — a tree from the wrong window was
   * never verified against the foreground app no matter how recently captured.
   */
  windowIdentityMismatch?: { observed: string; foreground: string };
  /**
   * The hierarchy contains only status-bar content while a non-system app is resumed. This is a
   * device-side wrong-window capture even when System UI would normally be a legitimate
   * accessibility window. `ctrlProxyIncomplete` is set when the accessibility service itself
   * reported that it could not read the focused application window (a null root), which is an
   * incomplete capture rather than a stale one and needs a different recovery (issue #6151).
   * `sdkInt` is the device API level when the capture reported one: the null root is a generic
   * signal (transient, app-restricted, or withheld), and only on Android 14+ can it be the
   * accessibility-data-sensitive withholding that a CtrlProxy update fixes.
   */
  statusBarOnlyHierarchy?: { foreground: string; ctrlProxyIncomplete?: boolean; sdkInt?: number };
  /**
   * The accessibility service reported the capture as incomplete (`ctrlProxyIncomplete`): it
   * could not read the focused application window. Consulted on the `unavailable` path, where a
   * rootless payload (no hierarchy node at all) never reaches the status-bar geometry gate but
   * still deserves the same recovery guidance, AND on the otherwise-readable path: split-screen
   * or a dialog transition can leave a non-error hierarchy for another window while the focused
   * application's root was still null, which trips neither `unavailable` nor
   * `statusBarOnlyHierarchy`. Either way freshness is retracted (issue #6151).
   */
  incompleteCapture?: { sdkInt?: number };
  /**
   * ADB and CtrlProxy disagree about the current activity within the same
   * application, and a forced recapture could not safely reconcile them.
   */
  activityAttributionMismatch?: boolean;
  /**
   * The observation carries no foreground application window at all:
   * `activeWindow.appId` is empty even after every fallback (viewHierarchy
   * packageName, etc.) has run, so nothing identifies which app — if any —
   * the captured hierarchy belongs to (issue #6220). This is the synchronous
   * counterpart to {@link statusBarOnlyHierarchy}: that gate needs an
   * independent, device-confirmed read of the foreground app to name the
   * mismatch, so when that confirming read itself comes back empty (or
   * races), a hierarchy that is honest about carrying no window identity must
   * still not be stamped `verified/isFresh: true`. Needs no device
   * round-trip — derived entirely from the observation already in hand.
   */
  missingForegroundWindow?: { reason: "status_bar_only" | "empty_active_window" };
  /** Age budget; defaults to {@link maxObservationAgeMs}. */
  maxAgeMs?: number;
}

export interface FreshnessVerdict {
  requestedAfter?: number;
  actualTimestamp?: number;
  /** Wall-clock age of the observation's capture timestamp. Always present when one exists. */
  ageMs?: number;
  /** Whether the delegate verified this tree against the device on this call. */
  verified?: boolean;
  /**
   * Whether this tree is believed to match the screen.
   *
   * NOTE the direction of the unknown case: when freshness cannot be
   * established this is `false`, not `true`. A freshness flag whose failure
   * mode is indistinguishable from success is not a freshness flag, and `true`
   * is the value a consumer acts on. `warning` always names the cause when this
   * is `false`.
   */
  isFresh: boolean;
  /** How far past the age budget the observation is, when it is. */
  staleDurationMs?: number;
  /** Names the CAUSE whenever `isFresh` is false. */
  warning?: string;
}

/**
 * The `requestedAfter` (explicit `minTimestamp`) branch, unchanged from the
 * original implementation so existing `waitFor` polling semantics are
 * byte-identical. Split out only to keep {@link computeFreshness} under the
 * repo's per-function complexity budget.
 */
function computeRequestedFreshness(
  requestedAfter: number,
  actualTimestamp: number | undefined,
  ageMs: number | undefined,
  verified: boolean | undefined,
): FreshnessVerdict {
  const isFresh = actualTimestamp !== undefined && actualTimestamp >= requestedAfter;
  const staleDurationMs =
    !isFresh && actualTimestamp !== undefined ? requestedAfter - actualTimestamp : undefined;
  return {
    requestedAfter,
    actualTimestamp,
    ageMs,
    verified,
    isFresh,
    staleDurationMs,
    warning: isFresh
      ? undefined
      : actualTimestamp === undefined
        ? "Observation carries no capture timestamp, so the requested minimum could not be checked."
        : `Observation was captured ${staleDurationMs}ms before the requested minimum timestamp.`,
  };
}

/**
 * Wall-clock age of the observation, measured in a single clock domain.
 *
 * Age subtracts a capture time from host `now`, so both operands must share a
 * clock. Prefer a host-authored basis when the source supplies one; only fall
 * back to the device-authored capture timestamp (iOS, which shares the host
 * clock). Subtracting a skewed device timestamp from host `now` reports the
 * clock skew as age (issue #5377). Clamped at 0 so a device clock running ahead
 * of the host cannot produce a negative age.
 */
function resolveAgeMs(
  hostAgeBasisMs: number | undefined,
  actualTimestamp: number | undefined,
  now: number,
): number | undefined {
  const ageBasis = hostAgeBasisMs ?? actualTimestamp;
  return ageBasis !== undefined ? Math.max(0, now - ageBasis) : undefined;
}

/**
 * First API level on which the framework withholds accessibility-data-sensitive
 * views (and so whole windows such as runtime permission dialogs) from an
 * accessibility service that does not declare `isAccessibilityTool`.
 */
const ACCESSIBILITY_DATA_SENSITIVE_MIN_SDK = 34;

/**
 * The service could not read the focused application window (issue #6151). The
 * null root is a generic signal — it also covers a transient root and an app
 * that restricts accessibility — so the advice is to retry first; only on
 * Android 14+ is the persistent case attributable to data-sensitive withholding,
 * which a CtrlProxy update (not home/relaunch) recovers.
 */
function unreadableFocusedWindowWarning(foreground: string, sdkInt: number | undefined): string {
  return `Observed hierarchy contains only Android status-bar content while the device's current top resumed activity is ${foreground}, and the accessibility service reported the focused application window as unreadable (no root node). This capture is incomplete rather than a stale window: the foreground window's content did not reach the service. ${incompleteCaptureGuidance(sdkInt)}`;
}

/**
 * Recovery guidance shared by every incomplete-capture verdict: retry first
 * (the null root can be transient), and on Android 14+ name the data-sensitive
 * withholding that only a CtrlProxy update recovers.
 */
function incompleteCaptureGuidance(sdkInt: number | undefined): string {
  const generic =
    "Observe again; if it stays unreadable after relaunching the app, the window's content is being withheld from the service.";
  if (sdkInt === undefined || sdkInt < ACCESSIBILITY_DATA_SENSITIVE_MIN_SDK) {
    return generic;
  }
  return `${generic} On Android 14+ a persistently unreadable focused window is the shape of an accessibility-data-sensitive surface (a runtime permission dialog, the Settings Wi-Fi picker) read by a CtrlProxy build that does not declare isAccessibilityTool; pressing home or relaunching does not recover that case. Update CtrlProxy to a build that declares isAccessibilityTool (fix for #6151) and observe again.`;
}

function resolveIdentityMismatch(
  inputs: FreshnessInputs,
  ageMs: number | undefined,
): FreshnessVerdict | undefined {
  const { requestedAfter, actualTimestamp } = inputs;
  if (inputs.windowIdentityMismatch) {
    const { observed, foreground } = inputs.windowIdentityMismatch;
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning: `Observed hierarchy is from ${observed}, but the device's current top resumed activity is ${foreground}. This is a stale wrong-window capture; it was not verified against the foreground app. The runner is serving a stale window; call pressButton { platform: "android", button: "home" } (or relaunch the target app) and observe again.`,
    };
  }
  if (inputs.statusBarOnlyHierarchy) {
    const { foreground, ctrlProxyIncomplete, sdkInt } = inputs.statusBarOnlyHierarchy;
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning: ctrlProxyIncomplete
        ? unreadableFocusedWindowWarning(foreground, sdkInt)
        : `Observed hierarchy contains only Android status-bar content while the device's current top resumed activity is ${foreground}. This is a stale wrong-window capture; it was not verified against the foreground app. The runner is serving a stale window; call pressButton { platform: "android", button: "home" } (or relaunch the target app) and observe again.`,
    };
  }
  if (inputs.activityAttributionMismatch) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning:
        "CtrlProxy and adb disagree about the current activity, and a fresh hierarchy could not reconcile them. The observation was not verified against the current activity; call observe again.",
    };
  }
  // The service reported the focused application's root as unreadable even
  // though the capture is otherwise readable (a status bar or an unrelated
  // window's content came through) — a split-screen pane or a dialog
  // transition can leave a non-null, non-error hierarchy that never trips the
  // `unavailable` or status-bar-only gates above. Retract freshness anyway:
  // the tree is honest about SOME window, but not about the focused
  // application (issue #6151).
  if (inputs.incompleteCapture) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning: `The accessibility service reported the capture as incomplete: it could not read the focused application's root window, even though another window's content was readable. ${incompleteCaptureGuidance(inputs.incompleteCapture.sdkInt)}`,
    };
  }
  // Lowest-priority fallback (issue #6220): none of the device-confirmed gates
  // above fired — most commonly because there was no ground-truth foreground
  // read to confirm against — yet the observation itself names no foreground
  // window at all. Every other branch above names the actual foreground app or
  // a more specific cause; this one only fires when nothing more specific could
  // be established.
  if (inputs.missingForegroundWindow) {
    const { reason } = inputs.missingForegroundWindow;
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning:
        reason === "status_bar_only"
          ? "Observed hierarchy contains only Android status-bar content and reports no foreground application window (activeWindow.appId is empty). This capture cannot be trusted to reflect any app's screen; call observe again."
          : "Observed hierarchy reports no foreground application window (activeWindow.appId is empty), so this capture cannot be trusted to reflect the current screen; call observe again.",
    };
  }
  return undefined;
}

/**
 * The `unavailable` warning. A rootless payload that carries the service's own
 * incomplete flag (issue #6151) names the unreadable focused window and its
 * recovery instead of a bare "could not be retrieved".
 */
function unavailableWarning(incompleteCapture: FreshnessInputs["incompleteCapture"]): string {
  if (!incompleteCapture) {
    return "View hierarchy could not be retrieved, so its freshness cannot be established.";
  }
  return `View hierarchy could not be retrieved: the accessibility service reported the capture as incomplete because it could not read the focused application window (no root node). ${incompleteCaptureGuidance(incompleteCapture.sdkInt)}`;
}

/**
 * Compute the freshness verdict.
 *
 * The `requestedAfter` branch is unchanged from the original implementation, so
 * existing `waitFor` polling semantics are byte-identical. Only the branch that
 * used to return the constant `true` is new.
 */
export function computeFreshness(inputs: FreshnessInputs): FreshnessVerdict {
  const { requestedAfter, actualTimestamp, hostAgeBasisMs, now, verified, unavailable } = inputs;
  const maxAgeMs = inputs.maxAgeMs ?? maxObservationAgeMs();

  const ageMs = resolveAgeMs(hostAgeBasisMs, actualTimestamp, now);

  if (unavailable) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: false,
      warning: unavailableWarning(inputs.incompleteCapture),
    };
  }

  // An app-, activity-, or content-level identity split dominates every other signal: a
  // client must not treat the tree as verified while its attribution is known to be inconsistent.
  const identityMismatch = resolveIdentityMismatch(inputs, ageMs);
  if (identityMismatch) {
    return identityMismatch;
  }

  // Caller supplied an explicit constraint: answer exactly that question.
  if (requestedAfter !== undefined) {
    return computeRequestedFreshness(requestedAfter, actualTimestamp, ageMs, verified);
  }

  // No constraint supplied. This is the path that used to hardcode `true`.
  if (actualTimestamp === undefined) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: false,
      warning: "Observation carries no capture timestamp, so its freshness cannot be established.",
    };
  }

  const overBudget = ageMs !== undefined && ageMs > maxAgeMs;

  // The delegate served a host-side cache entry it could not re-verify against
  // the device. That is unfresh at ANY age: the tree was never checked against
  // the screen on this call, so its age is a lower bound on how wrong it may be.
  if (verified === false) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: false,
      staleDurationMs: overBudget ? ageMs : undefined,
      warning: `Hierarchy was served from the host-side cache without being re-verified against the device (captured ${ageMs}ms ago). The runner did not answer a synchronous hierarchy request.`,
    };
  }

  // The delegate DID verify this tree against the device on this call, so it was
  // the freshest tree obtainable. Age past the budget here measures how long the
  // REST of the observation took (screenshot, audits, element extraction on a
  // dense screen), not a stale channel — reporting that as `isFresh: false`
  // would be a false alarm on a perfectly healthy read. Report the age and warn,
  // but do not retract the verdict; `ageMs` is always present for a consumer
  // working to a tighter budget than this one.
  if (verified === true) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: true,
      warning: overBudget
        ? `Hierarchy was verified against the device on this call but is already ${ageMs}ms old (budget ${maxAgeMs}ms) — the rest of the observation was slow.`
        : undefined,
    };
  }

  // The source cannot report whether it verified (no delegate plumbing on this
  // platform yet — Android). Age is the only evidence available, so use it.
  if (overBudget) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: false,
      staleDurationMs: ageMs,
      warning: `Hierarchy was captured ${ageMs}ms ago, past the ${maxAgeMs}ms freshness budget (AUTOMOBILE_MAX_OBSERVATION_AGE_MS), and the source did not report whether it was verified against the device.`,
    };
  }

  return { requestedAfter, actualTimestamp, ageMs, verified, isFresh: true };
}
