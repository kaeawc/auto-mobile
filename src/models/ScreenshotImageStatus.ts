export type ScreenshotImageStatus =
  | { included: true; mimeType: string; sizeBytes: number }
  | { included: false; reason: string; sizeBytes?: number; capBytes?: number };
