import type {
  DisposableAppStamped,
  DisposableAppStamper,
  DisposableAppStampInput,
} from "../../src/features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppTemplate } from "../../src/features/prototype/disposableApp/disposableAppTemplates";

export class FakeDisposableAppStamper implements DisposableAppStamper {
  readonly stamped: DisposableAppStampInput[] = [];

  constructor(
    private readonly offered: readonly DisposableAppTemplate[] = [
      { name: "base", capabilities: [], size: 1 },
    ],
    readonly signerDigest = "host-key",
  ) {}

  async templates(): Promise<readonly DisposableAppTemplate[]> {
    return this.offered;
  }

  async signer(): Promise<string> {
    return this.signerDigest;
  }

  async stamp(input: DisposableAppStampInput): Promise<DisposableAppStamped> {
    this.stamped.push(input);
    return { artifactPath: `/stamped/${input.appId}.apk`, version: `1.0.${this.stamped.length}` };
  }
}
