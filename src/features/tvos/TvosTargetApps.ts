import { InMemoryVisionosTargetApps } from "../visionos/VisionosTargetApps";

/**
 * The app each Apple TV simulator was last told to launch. The tvOS runner reads the foreground
 * app per command and probes only first-party apps on its own, so hierarchy and text requests
 * name this app as a hint; a hint that is no longer in front falls through on the runner (#17310).
 */
export const tvosTargetApps = new InMemoryVisionosTargetApps();
