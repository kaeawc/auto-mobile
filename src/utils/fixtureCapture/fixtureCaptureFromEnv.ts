import { ENV, readEnvTrimmed } from "../../config/env";
import { getMcpServerVersion } from "../mcpVersion";
import { defaultTimer, type Timer } from "../SystemTimer";
import { DirectoryFixtureCaptureWriter } from "./FixtureCaptureWriter";
import { runWithFixtureCapture, type FixtureCaptureDeps } from "./fixtureCaptureScope";

/** Capture deps when `AUTOMOBILE_CAPTURE_FIXTURES_DIR` is set; undefined (capture off) otherwise. */
export function fixtureCaptureFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  timer: Pick<Timer, "now"> = defaultTimer,
): FixtureCaptureDeps | undefined {
  const dir = readEnvTrimmed(ENV.CAPTURE_FIXTURES_DIR, env);
  if (!dir) {
    return undefined;
  }
  return {
    writer: new DirectoryFixtureCaptureWriter(dir, timer),
    timer,
    automobileVersion: getMcpServerVersion,
  };
}

/**
 * Wrap a tool handler so each call runs in its own capture scope. The variable is read per call;
 * while it is unset the wrapper calls `handler` directly and records nothing.
 */
export function withToolCallCapture<A extends unknown[], R>(
  toolName: string,
  handler: (...args: A) => Promise<R>,
  env: NodeJS.ProcessEnv = process.env,
): (...args: A) => Promise<R> {
  return (...args) =>
    runWithFixtureCapture(toolName, fixtureCaptureFromEnv(env), () => handler(...args));
}
