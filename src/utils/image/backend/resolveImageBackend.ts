import type { ImageBackend } from "./ImageBackend";
import { JimpBackend } from "./JimpBackend";
import { SharpBackend, type SharpLoader } from "./SharpBackend";

export interface ResolveImageBackendOptions {
  platform?: NodeJS.Platform;
  sharpLoader?: SharpLoader;
}

/**
 * Selects the image backend for the current platform.
 *
 * Returns sharp on macOS/Linux and jimp on Windows. The next milestone step
 * replaces the Windows jimp WebP leg with cwebp while keeping this selection
 * seam stable for call sites.
 */
export function resolveImageBackend(options: ResolveImageBackendOptions = {}): ImageBackend {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return new JimpBackend();
  }
  if (platform === "darwin" || platform === "linux") {
    return new SharpBackend({
      loadSharp: options.sharpLoader,
      fallbackBackend: new JimpBackend()
    });
  }
  return new JimpBackend();
}
