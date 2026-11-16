import { PrototypeFakeMediaEngine } from "../../src/features/prototype/prototypeFakeMediaEngine";
import type { PrototypeMediaSimRequest } from "../../src/features/prototype/prototypeFakeMediaEngine";
import type {
  PrototypeMediaEngineKind,
  PrototypeMediaSimReply,
  PrototypeMediaSimRoute,
} from "../../src/features/prototype/prototypeMediaSimulate";

/** A media route that records every delivery and applies it to a real fake engine. */
export class FakePrototypeMediaSimRoute implements PrototypeMediaSimRoute {
  readonly delivered: Array<{ id: string; request: PrototypeMediaSimRequest; timeoutMs?: number }> =
    [];
  readonly media: PrototypeFakeMediaEngine = new PrototypeFakeMediaEngine();
  private failure: Error | undefined;

  constructor(private readonly kind: PrototypeMediaEngineKind | undefined) {}

  failWith(error: Error): void {
    this.failure = error;
  }

  async engine(): Promise<PrototypeMediaEngineKind | undefined> {
    return this.kind;
  }

  async deliver(
    id: string,
    request: PrototypeMediaSimRequest,
    timeoutMs?: number,
  ): Promise<PrototypeMediaSimReply> {
    this.delivered.push({ id, request, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (this.failure) {
      throw this.failure;
    }
    const result = this.media.simulate(request);
    return result.success ? { success: true } : { success: false, code: result.code };
  }
}
