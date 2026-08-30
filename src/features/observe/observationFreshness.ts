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
 * Compute the freshness verdict.
 *
 * The `requestedAfter` branch is unchanged from the original implementation, so
 * existing `waitFor` polling semantics are byte-identical. Only the branch that
 * used to return the constant `true` is new.
 */
export function computeFreshness(inputs: FreshnessInputs): FreshnessVerdict {
  const { requestedAfter, actualTimestamp, hostAgeBasisMs, now, verified, unavailable } = inputs;
  const windowIdentityMismatch = inputs.windowIdentityMismatch;
  const maxAgeMs = inputs.maxAgeMs ?? maxObservationAgeMs();

  const ageMs = resolveAgeMs(hostAgeBasisMs, actualTimestamp, now);

  if (unavailable) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified,
      isFresh: false,
      warning: "View hierarchy could not be retrieved, so its freshness cannot be established.",
    };
  }

  // The tree belongs to a different app than the one currently resumed on the
  // device (issue #5867). This dominates every other signal — a wrong-window
  // capture is unfresh at any age, and `verified` is retracted to false so a
  // consumer reading that field alone is not green-lit onto a phantom.
  if (windowIdentityMismatch) {
    return {
      requestedAfter,
      actualTimestamp,
      ageMs,
      verified: false,
      isFresh: false,
      warning: `Observed hierarchy is from ${windowIdentityMismatch.observed}, but the device's current top resumed activity is ${windowIdentityMismatch.foreground}. This is a stale wrong-window capture; it was not verified against the foreground app. The runner is serving a stale window; call pressButton { platform: "android", button: "home" } (or relaunch the target app) and observe again.`,
    };
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
