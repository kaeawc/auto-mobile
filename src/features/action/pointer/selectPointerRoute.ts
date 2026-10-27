import { ActionableError } from "../../../models/ActionableError";
import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import {
  describePointerFeatures,
  invalidPointerFeatures,
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
  device: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerRouteChoice {
  const invalid = invalidPointerFeatures(features);
  if (invalid) {
    return {
      selected: null,
      missingCapabilities: [],
      refusal: `${describePointerFeatures(features)} is not a valid pointer request: ${invalid}.`,
    };
  }
  const reasons: string[] = [];
  const missing = new Set<string>();
  for (const injector of injectors) {
    const support = injector.supports(features, device);
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
      ? ` Use a device whose runner advertises ${missingCapabilities.join(" and ")}.`
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
  device: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerInjector {
  const choice = selectPointerRoute(features, device, injectors);
  if (choice.selected === null) {
    throw new ActionableError(choice.refusal);
  }
  return choice.selected;
}

/**
 * The host-side `pointerInput` summary, derived from the same route support the dispatcher uses so
 * it can never disagree with it. Each feature names the route that would carry it: a plain stylus
 * stroke can take the shell while pressure and hover need instrumentation.
 */
export interface PointerInputSummary {
  stylus: boolean;
  pressure: boolean;
  hover: boolean;
  stylusRoute: PointerRouteId | null;
  pressureRoute: PointerRouteId | null;
  hoverRoute: PointerRouteId | null;
}

export function derivePointerInput(
  device: PointerEnvironment,
  injectors: readonly PointerInjector[],
): PointerInputSummary {
  const routeFor = (features: PointerFeatures): PointerRouteId | null =>
    selectPointerRoute(features, device, injectors).selected?.route ?? null;
  const stylusRoute = routeFor({ toolType: "stylus" });
  const pressureRoute = routeFor({ toolType: "stylus", variablePressure: true });
  const hoverRoute = routeFor({ toolType: "stylus", hover: true });
  return {
    stylus: stylusRoute !== null,
    pressure: pressureRoute !== null,
    hover: hoverRoute !== null,
    stylusRoute,
    pressureRoute,
    hoverRoute,
  };
}
/** The pointer-related capability flags in a runner's advertised set. */
export function pointerCapabilities(has: (capability: string) => boolean): Set<string> {
  return new Set(
    [STYLUS_INPUT_CAPABILITY, HOVER_INPUT_CAPABILITY].filter((capability) => has(capability)),
  );
}
