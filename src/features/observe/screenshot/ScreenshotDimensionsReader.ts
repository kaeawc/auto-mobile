import { open } from "node:fs/promises";
import {
  readImageHeaderDimensions,
  type ImagePixelDimensions,
} from "../../../utils/screenshot/imageHeaderDimensions";

export interface ScreenshotDimensionsReader {
  read(path: string): Promise<ImagePixelDimensions | null>;
}

/** Best-effort container header read. Oversized JPEG headers fail closed; no pixel decode. */
export class HeaderScreenshotDimensionsReader implements ScreenshotDimensionsReader {
  async read(path: string): Promise<ImagePixelDimensions | null> {
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return readImageHeaderDimensions(header.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }
}
