import { ENV, readEnvTrimmed } from "../../config/env";
import { getSettledMcpServerVersion, getSettledSourceTreeState } from "../mcpVersion";
import { defaultTimer, type Timer } from "../SystemTimer";
import { DirectoryFixtureCaptureWriter } from "./FixtureCaptureWriter";
import {
  runWithFixtureCapture,
  type CaptureSourceIdentity,
  type FixtureCaptureDeps,
} from "./fixtureCaptureScope";

/** The version and tree state once this process's dirty-state probe has answered. */
async function settledSourceIdentity(): Promise<CaptureSourceIdentity> {
  const [automobileVersion, sourceTreeState] = await Promise.all([
    getSettledMcpServerVersion(),
    getSettledSourceTreeState(),
  ]);
  return { automobileVersion, sourceTreeState };
}

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
    sourceIdentity: settledSourceIdentity,
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
