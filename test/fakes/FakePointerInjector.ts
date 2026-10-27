import type {
  PointerEnvironment,
  PointerFeatures,
  PointerInjector,
  PointerRequest,
  PointerRouteId,
  PointerSupport,
} from "../../src/features/action/pointer/PointerInjector";

/** A route whose support is scripted and whose injections are recorded. */
export class FakePointerInjector implements PointerInjector {
  readonly injected: PointerRequest[] = [];
  readonly asked: PointerFeatures[] = [];
  failure?: Error;

  constructor(
    readonly route: PointerRouteId,
    private support:
      | PointerSupport
      | ((features: PointerFeatures, env: PointerEnvironment) => PointerSupport) = {
      supported: true,
    },
  ) {}

  supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport {
    this.asked.push(features);
    return typeof this.support === "function" ? this.support(features, environment) : this.support;
  }

  async inject(request: PointerRequest): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    this.injected.push(request);
  }
}
