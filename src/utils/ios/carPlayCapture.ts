import {
  type CarPlayProjectingState,
  type CarPlayProjectionProbe,
  requireCarPlayProjection,
} from "./carPlayProjection";
import type { CarPlayRuntimeReader } from "./carPlayRuntime";

export function carPlayCaptureDisplay(state: CarPlayProjectingState): string {
  return String(state.displayId);
}

export async function captureCarPlayScreen(
  udid: string,
  deps: {
    probe: CarPlayProjectionProbe;
    runtime: CarPlayRuntimeReader;
    screenshot: (udid: string, display: string, signal?: AbortSignal) => Promise<Buffer>;
  },
  signal?: AbortSignal,
): Promise<Buffer> {
  const state = await requireCarPlayProjection(udid, deps);
  return deps.screenshot(udid, carPlayCaptureDisplay(state), signal);
}
