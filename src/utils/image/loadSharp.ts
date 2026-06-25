import os from "os";

type SharpModule = typeof import("sharp");
type SharpFactory = SharpModule["default"];
export type SharpImporter = () => Promise<SharpModule>;

let sharpFactoryPromise: Promise<SharpFactory> | undefined;
let runtimeConfigured = false;

const defaultImporter: SharpImporter = () => import("sharp");

/**
 * Bound sharp's process-wide resource usage for a long-running, multi-agent
 * daemon. Without this, the always-on screenshot keepalive plus parallel observe
 * traffic can let libvips' cache and thread pool grow unbounded.
 *
 * Best-effort: runtime tuning must never break image loading itself.
 */
function configureSharpRuntime(sharp: SharpFactory): void {
  if (runtimeConfigured) {
    return;
  }
  try {
    sharp.cache({ memory: 50, items: 50, files: 0 });
    sharp.concurrency(Math.max(1, Math.min(4, os.cpus().length)));
    runtimeConfigured = true;
  } catch {
    // Ignore — leave sharp at its defaults rather than failing image features.
  }
}

/**
 * Lazily load the sharp factory (memoized) and apply bounded resource settings
 * on first successful load.
 *
 * Callers on hot paths (the screenshot keepalive, observe streaming) MUST still
 * try/catch and degrade: the daemon exits on an unhandledRejection, so a sharp
 * error must never reach the event loop. (The streaming call sites already do
 * this — see AndroidCtrlProxyClient/IOSCtrlProxyClient and ScreenshotComparator.)
 *
 * Note: a failed load is memoized (not retried). A missing/incompatible native
 * binary is a permanent install problem, not a transient one, so retrying every
 * call would only add latency and log noise.
 *
 * @param importer injectable for testing; defaults to `import("sharp")`.
 */
export async function loadSharp(importer: SharpImporter = defaultImporter): Promise<SharpFactory> {
  sharpFactoryPromise ??= importer().then(mod => {
    const sharp = mod.default;
    configureSharpRuntime(sharp);
    return sharp;
  });
  return sharpFactoryPromise;
}

/** Reset memoized state. Test-only seam. */
export function resetSharpForTesting(): void {
  sharpFactoryPromise = undefined;
  runtimeConfigured = false;
}
