import {
  H264AnnexBParser,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  nalUnitType,
} from "../../src/features/webrtc/h264";

export interface H264CaptureReadiness {
  readonly chunks: Buffer[];
  onData(chunk: Buffer): void;
  onError(error: Error): void;
  wait(): Promise<void>;
}

/**
 * Resolves from the stream itself once the decoder configuration and an IDR are
 * present. Integration captures should wait for this observable boundary rather
 * than an arbitrary amount of encoded video.
 */
export function createH264CaptureReadiness(
  minimumSpsCount: number = 1,
  timeoutMs: number = 15_000,
): H264CaptureReadiness {
  const chunks: Buffer[] = [];
  const parser = new H264AnnexBParser();
  const counts = new Map<number, number>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const clearDeadline = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  const checkReady = (): void => {
    if (
      !settled &&
      (counts.get(NAL_TYPE_SPS) ?? 0) >= minimumSpsCount &&
      (counts.get(NAL_TYPE_PPS) ?? 0) >= 1 &&
      (counts.get(NAL_TYPE_IDR) ?? 0) >= 1
    ) {
      settled = true;
      clearDeadline();
      resolveReady();
    }
  };

  return {
    chunks,
    onData(chunk): void {
      chunks.push(chunk);
      for (const nal of parser.push(chunk)) {
        const type = nalUnitType(nal);
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      checkReady();
    },
    onError(error): void {
      if (!settled) {
        settled = true;
        clearDeadline();
        rejectReady(error);
      }
    },
    async wait(): Promise<void> {
      if (!settled) {
        timeout = setTimeout(() => {
          settled = true;
          rejectReady(
            new Error(
              `H.264 capture did not emit ${minimumSpsCount} SPS, PPS, and an IDR within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      try {
        await ready;
      } finally {
        clearDeadline();
      }
    },
  };
}
