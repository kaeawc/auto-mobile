import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #11512: the plan orchestrator falls back to the real video recorder (`adb screenrecord`,
 * `ffmpeg -version`) unless a test injects one. The only thing that used to stop that was the
 * default-database guard, which does not apply once AUTOMOBILE_DB_DIR is set. Every unit suite
 * that builds an orchestrator, or runs the executePlan tool (which builds one without a seam),
 * must therefore name its recorder explicitly.
 */
const SERVER_TEST_DIR = import.meta.dir;
const SELF = path.basename(import.meta.path);

const unitSources = (): Array<{ file: string; text: string }> =>
  Array.from(new Bun.Glob("*.test.ts").scanSync({ cwd: SERVER_TEST_DIR }))
    .filter((file) => !file.endsWith(".integration.test.ts") && file !== SELF)
    .map((file) => ({ file, text: readFileSync(path.join(SERVER_TEST_DIR, file), "utf8") }));

test("unit suites never reach the default plan video recorder", () => {
  const sources = unitSources();

  const orchestratorWithoutRecorder = sources
    .filter(({ text }) => /new PlanExecutionOrchestrator\(/.test(text))
    .filter(({ text }) => !/videoRecorder\b/.test(text))
    .map(({ file }) => file);
  const executePlanToolWithoutFakeManager = sources
    .filter(({ text }) => /registerPlanTools\(\)/.test(text))
    .filter(({ text }) => /getTool\("executePlan"\)!?\.handler\(/.test(text))
    .filter(({ text }) => !/spyOn\(videoRecordingManager, "startVideoRecording"\)/.test(text))
    .map(({ file }) => file);

  expect({ orchestratorWithoutRecorder, executePlanToolWithoutFakeManager }).toEqual({
    orchestratorWithoutRecorder: [],
    executePlanToolWithoutFakeManager: [],
  });
});
