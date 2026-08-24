import type { ImageBackend } from "./ImageBackend";
import { JimpBackend } from "./JimpBackend";
import { JimpCliBackend } from "./JimpCliBackend";
import { SharpBackend, type SharpLoader } from "./SharpBackend";

export interface ResolveImageBackendOptions {
  platform?: NodeJS.Platform;
  sharpLoader?: SharpLoader;
}

/**
 * Selects the image backend for the current platform.
 *
 * Returns sharp on macOS/Linux and jimp+cwebp on Windows.
 */
export function resolveImageBackend(options: ResolveImageBackendOptions = {}): ImageBackend {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return new JimpCliBackend();
  }
  if (platform === "darwin" || platform === "linux") {
    return new SharpBackend({
      loadSharp: options.sharpLoader,
      fallbackBackend: new JimpBackend(),
    });
  }
  return new JimpBackend();
}
