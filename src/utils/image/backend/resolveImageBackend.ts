import type { ImageBackend } from "./ImageBackend";
import { JimpBackend } from "./JimpBackend";

/**
 * Selects the image backend for the current platform.
 *
 * Returns `JimpBackend` unconditionally for now — platform-aware selection
 * (sharp on most platforms, cwebp on Windows) lands with later issues in the
 * "Sharp + CWebP" milestone (#3010/#3011). Kept as a function seam so those
 * issues change selection here without touching `ImageTransformer`.
 */
export function resolveImageBackend(): ImageBackend {
  return new JimpBackend();
}
