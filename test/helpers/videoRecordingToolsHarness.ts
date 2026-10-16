import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerVideoRecordingTools,
  type VideoRecordingToolDependencies,
} from "../../src/server/videoRecordingTools";

/**
 * Registers the video recording tools with accumulating dependency overrides, so a test can
 * set the device detector and requester resolver independently (and mid-test) while every
 * registration starts from the real defaults and nothing leaks into the next test.
 */
export function createVideoRecordingToolsHarness() {
  let dependencies: VideoRecordingToolDependencies = {};

  return {
    /** Register (or re-register) the tools with the overrides collected so far. */
    register(): void {
      registerVideoRecordingTools(dependencies);
    },
    /** Merge `overrides` and re-register so the tool handlers see them. */
    configure(overrides: VideoRecordingToolDependencies): void {
      dependencies = { ...dependencies, ...overrides };
      registerVideoRecordingTools(dependencies);
    },
    /** Forget every override and unregister the handler, so none outlives the test. */
    clear(): void {
      dependencies = {};
      ToolRegistry.removeToolForTesting("videoRecording");
    },
  };
}
