import {
  type CarPlayProjectingState,
  type CarPlayProjectionProbe,
  requireCarPlayProjection,
} from "./carPlayProjection";

export function carPlayCaptureDisplay(state: CarPlayProjectingState): string {
  return String(state.displayId);
}

export async function captureCarPlayScreen(
  udid: string,
  deps: {
    probe: CarPlayProjectionProbe;
    screenshot: (udid: string, display: string, signal?: AbortSignal) => Promise<Buffer>;
  },
  signal?: AbortSignal,
): Promise<Buffer> {
  const state = await requireCarPlayProjection(udid, deps.probe);
  return deps.screenshot(udid, carPlayCaptureDisplay(state), signal);
}
