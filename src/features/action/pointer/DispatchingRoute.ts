import type {
  PointerEnvironment,
  PointerFeatures,
  PointerInjector,
  PointerRequest,
  PointerRouteId,
  PointerSupport,
} from "./PointerInjector";

/** Performs the injection for one route; the real transports live beside their own routes. */
export type PointerDispatch = (request: PointerRequest, signal?: AbortSignal) => Promise<void>;

export const SUPPORTED: PointerSupport = { supported: true };

export function unsupported(reason: string, missingCapability?: string): PointerSupport {
  return missingCapability
    ? { supported: false, reason, missingCapability }
    : { supported: false, reason };
}

/** A route whose `supports` is its own and whose injection is a supplied dispatch. */
export abstract class DispatchingRoute implements PointerInjector {
  abstract readonly route: PointerRouteId;
  constructor(private readonly dispatch: PointerDispatch) {}
  abstract supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport;
  inject(request: PointerRequest, signal?: AbortSignal): Promise<void> {
    return this.dispatch(request, signal);
  }
}
