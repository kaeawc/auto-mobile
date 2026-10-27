import type { SimctlScreenshotFailureReason } from "./SimCtlClient";

export class SimctlScreenshotError extends Error {
  readonly reason: SimctlScreenshotFailureReason;
  readonly exitCode: number | null;
  readonly stderrExcerpt: string;
  readonly byteLength: number;

  constructor(
    reason: SimctlScreenshotFailureReason,
    message: string,
    options: {
      exitCode?: number | null;
      stderr?: string;
      byteLength?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SimctlScreenshotError";
    this.reason = reason;
    this.exitCode = options.exitCode ?? null;
    this.stderrExcerpt = (options.stderr ?? "").slice(0, 300);
    this.byteLength = options.byteLength ?? 0;
  }
}
