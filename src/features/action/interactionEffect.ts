import type { ObserveResult } from "../../models";
import type { TapEffect } from "../../models/TapOnElementResult";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";

function compareScreenIdentity(
  previousObservation: ObserveResult,
  currentObservation: ObserveResult,
): TapEffect | undefined {
  const previous = previousObservation.screenIdentity;
  const current = currentObservation.screenIdentity;
  if (!previous || !current || previous.platform !== current.platform) {
    return undefined;
  }
  const changed = previous.key !== current.key;
  return {
    screenChanged: changed,
    basis: changed ? "screenIdentity changed" : "screenIdentity unchanged",
  };
}

export function compareActiveWindow(
  previousObservation: ObserveResult,
  currentObservation: ObserveResult,
): TapEffect | undefined {
  const previous = previousObservation.activeWindow;
  const current = currentObservation.activeWindow;
  if (!hasCompleteActiveWindow(previous) || !hasCompleteActiveWindow(current)) {
    return undefined;
  }
  // layoutSeqSum comes from dumpsys, while hierarchy-derived windows use 0.
  // Even two non-zero samples do not establish a visible change on their own;
  // the hierarchy comparison below supplies that evidence for the same activity.
  const changed =
    previous.appId !== current.appId || previous.activityName !== current.activityName;
  return {
    screenChanged: changed,
    basis: changed ? "activeWindow changed" : "activeWindow unchanged",
  };
}

function hasCompleteActiveWindow(
  activeWindow: ObserveResult["activeWindow"],
): activeWindow is NonNullable<ObserveResult["activeWindow"]> {
  return Boolean(
    activeWindow?.appId && activeWindow.activityName && Number.isInteger(activeWindow.layoutSeqSum),
  );
}

function compareViewHierarchy(
  previousObservation: ObserveResult,
  currentObservation: ObserveResult,
): TapEffect | undefined {
  const previousHash = hierarchyFingerprint(previousObservation.viewHierarchy ?? null);
  const currentHash = hierarchyFingerprint(currentObservation.viewHierarchy ?? null);
  if (!previousHash || !currentHash) {
    return undefined;
  }
  const changed = previousHash !== currentHash;
  return {
    screenChanged: changed,
    basis: changed ? "viewHierarchy changed" : "viewHierarchy unchanged",
  };
}

/**
 * Issue #6258: a basis that resolves to "unchanged" must not stop the chain
 * — it must fall through to the next basis rather than being taken as final
 * proof nothing changed. A dialog open (e.g. the Material time picker) is
 * the known dialog-window gap (#6151): `activeWindow` never reflects the new
 * dialog window, so it resolves "unchanged" even though the hierarchy
 * clearly changed. The old `??` chain stopped at the first *defined* result
 * regardless of its `screenChanged` value, so `activeWindow unchanged`
 * masked a real `viewHierarchy changed`. Priority order (screenIdentity,
 * then activeWindow, then viewHierarchy) is preserved for a basis that DOES
 * report a change; when none report a change, the highest-priority
 * available basis is returned (matching prior "all unchanged" behavior).
 */
export function deriveInteractionEffect(
  previousObservation: ObserveResult | null,
  currentObservation: ObserveResult | undefined,
): TapEffect | undefined {
  if (!previousObservation || !currentObservation) {
    return undefined;
  }
  const hierarchyResult = compareViewHierarchy(previousObservation, currentObservation);
  const results = [
    compareScreenIdentity(previousObservation, currentObservation),
    compareActiveWindow(previousObservation, currentObservation),
    hierarchyResult,
  ].filter((result): result is NonNullable<typeof result> => result !== undefined);

  // A matching pair of device trees rules out a visible screen change even
  // when side-channel identity metadata was sampled from different moments.
  if (hierarchyResult && !hierarchyResult.screenChanged) {
    return results.find((result) => !result.screenChanged) ?? hierarchyResult;
  }

  const changedResult = results.find((result) => result.screenChanged);
  if (changedResult) {
    return changedResult;
  }

  return results[0] ?? { screenChanged: false, basis: "insufficient observation data" };
}
