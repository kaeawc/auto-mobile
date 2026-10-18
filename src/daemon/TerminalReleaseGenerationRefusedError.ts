import { DeviceSessionRowNotReleasableError } from "../db/DeviceSessionRowNotReleasableError";

/** In-process refusal; unlike a SQL miss it needs no peer/generation reclassification. */
export class TerminalReleaseGenerationRefusedError extends DeviceSessionRowNotReleasableError {}
