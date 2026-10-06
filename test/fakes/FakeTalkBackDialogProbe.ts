import type {
  TalkBackDialogProbe,
  TalkBackDialogProbeResult,
} from "../../src/features/accessibility/TalkBackDialogProbe";

/**
 * Scripted TalkBack consent-dialog probe. Queued results are consumed in order;
 * once the queue is empty every probe returns the default, which starts as
 * "no dialog".
 */
export class FakeTalkBackDialogProbe implements TalkBackDialogProbe {
  private readonly script: TalkBackDialogProbeResult[] = [];
  private fallback: TalkBackDialogProbeResult = { kind: "none" };
  probeCount = 0;

  enqueue(...results: TalkBackDialogProbeResult[]): this {
    this.script.push(...results);
    return this;
  }

  /** Result returned once the queue is empty. */
  setDefault(result: TalkBackDialogProbeResult): this {
    this.fallback = result;
    return this;
  }

  async probe(): Promise<TalkBackDialogProbeResult> {
    this.probeCount++;
    return this.script.shift() ?? this.fallback;
  }
}
