import { ActionableError } from "../../models";

/**
 * A helper that advertised no encoded-video capability failed to start encoded
 * capture — i.e. an outdated binary that predates `--encode h264`. Signals
 * {@link IosH264Source.establishCapture} to fall back to the raw ffmpeg pipeline
 * (issue #4789).
 */
export class EncodedUnsupportedError extends ActionableError {}
