import { ActionableError } from "../../../models/ActionableError";
import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import {
  describePointerFeatures,
  type PointerEnvironment,
  type PointerFeatures,
  type PointerInjector,
  type PointerRouteId,
} from "./PointerInjector";

export type PointerRouteChoice =
  | { selected: PointerInjector }
  | { selected: null; refusal: string; missingCapabilities: string[] };

/**
 * Chooses the first injector, in the order given, that can honour [features]. Callers list the
 * accessibility route first, so a finger touch keeps the fast path; anything else moves off it.
 * When none can, the refusal names every route's reason and each missing capability, so the
 * caller can refuse before dispatch with something actionable.
 */
export function selectPointerRoute(
  features: PointerFeatures,
  environment: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerRouteChoice {
  const reasons: string[] = [];
  const missing = new Set<string>();
  for (const injector of injectors) {
    const support = injector.supports(features, environment);
    if (support.supported) {
      return { selected: injector };
    }
    reasons.push(`${injector.route}: ${support.reason}`);
    if (support.missingCapability) {
      missing.add(support.missingCapability);
    }
  }
  const missingCapabilities = [...missing];
  const hint =
    missingCapabilities.length > 0
      ? ` Update CtrlProxy or use a device whose runner advertises ${missingCapabilities.join(" and ")}.`
      : "";
  return {
    selected: null,
    missingCapabilities,
    refusal: `${describePointerFeatures(features)} input cannot be injected on this device, and a finger touch is never substituted. ${reasons.join("; ")}.${hint}`,
  };
}

/** Throws the refusal as an {@link ActionableError}, or returns the chosen injector. */
export function requirePointerRoute(
  features: PointerFeatures,
  environment: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerInjector {
  const choice = selectPointerRoute(features, environment, injectors);
  if (choice.selected === null) {
    throw new ActionableError(choice.refusal);
  }
  return choice.selected;
}

/**
 * The host-side `pointerInput` summary, derived from the same route support the dispatcher uses so
 * it can never disagree with it. `route` is the one a stylus tap would take.
 */
export interface PointerInputSummary {
  route: PointerRouteId | null;
  stylus: boolean;
  pressure: boolean;
  hover: boolean;
}

export function derivePointerInput(
  environment: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerInputSummary {
  const pick = (features: PointerFeatures) => selectPointerRoute(features, environment, injectors);
  const stylus = pick({ toolType: "stylus" });
  return {
    route: stylus.selected?.route ?? null,
    stylus: stylus.selected !== null,
    pressure: pick({ toolType: "stylus", variablePressure: true }).selected !== null,
    hover: pick({ toolType: "stylus", hover: true }).selected !== null,
  };
}

/** The pointer-related capability flags in a runner's advertised set. */
export function pointerCapabilities(has: (capability: string) => boolean): Set<string> {
  return new Set(
    [STYLUS_INPUT_CAPABILITY, HOVER_INPUT_CAPABILITY].filter((capability) => has(capability)),
  );
}
