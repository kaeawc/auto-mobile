import type { BootedDevice } from "../../models";
import type { OrientationReader } from "./OrientationReader";

/**
 * CtrlProxy exposes orientation only as part of its rotate response; it has no
 * read-only orientation query, so this seam cannot safely report an iOS value yet.
 */
export class IosOrientationReader implements OrientationReader {
  async readOrientation(
    _device: BootedDevice,
    _signal?: AbortSignal,
  ): Promise<"portrait" | "landscape" | null> {
    return null;
  }
}
