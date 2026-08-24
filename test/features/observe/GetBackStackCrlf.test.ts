import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BackStackInfo, BootedDevice } from "../../../src/models";

/**
 * `GetBackStack` must parse CRLF `dumpsys activity activities` output the same
 * as LF (issue #4333).
 *
 * The parser splits on `\n` and matches each line with regexes anchored on
 * `(.*)$` / `$` (e.g. `MODERN_TASK_HEADER`). With CRLF input every line keeps a
 * trailing `\r`, which those anchors reject, so the parser silently returns
 * ZERO tasks and degrades to `partial: true`. A Windows `adb.exe shell` whose
 * shell-protocol layer performs CRLF translation emits exactly this at runtime.
 *
 * Deferred from PR #4332, which worked around it test-side (fixture
 * `\r\n`->`\n` normalization + `.gitattributes eol=lf`) without making the
 * production parser CRLF-tolerant. This suite pins the parser itself: it feeds a
 * REAL capture as both LF and CRLF and asserts identical, non-empty results.
 */

const CAPTURE_DIR = path.join(__dirname, "activityActivitiesDumps");
const device: BootedDevice = { name: "test", platform: "android", deviceId: "test-device" };

function readCaptureLf(file: string): string {
  // Normalize any incidental CRLF from the checkout to LF so the CRLF variant
  // below is the ONLY carriage-return source under test.
  return fs.readFileSync(path.join(CAPTURE_DIR, file), "utf8").replace(/\r\n/g, "\n");
}

async function parse(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
  return new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
}

// Every real capture, so the tolerance is proven across all supported levels
// rather than one hand-picked one.
const CAPTURES = fs
  .readdirSync(CAPTURE_DIR)
  .filter((f) => f.endsWith(".log"))
  .sort();

describe("GetBackStack CRLF tolerance (issue #4333)", () => {
  test("has real captures to assert against", () => {
    expect(CAPTURES.length).toBeGreaterThan(0);
  });

  for (const file of CAPTURES) {
    test(`${file}: CRLF input parses identically to LF`, async () => {
      const lf = readCaptureLf(file);
      const crlf = lf.replace(/\n/g, "\r\n");

      const lfResult = await parse(lf);
      const crlfResult = await parse(crlf);

      // The LF baseline must itself be a real, non-empty parse, otherwise the
      // equality below would be vacuously satisfied by two empty results.
      expect(lfResult.tasks.length).toBeGreaterThan(0);
      expect(lfResult.activities.length).toBeGreaterThan(0);
      expect(lfResult.partial).toBeUndefined();

      // CRLF must produce the SAME structured result -- this is the failure the
      // issue reproduces: CRLF -> 0 tasks today.
      expect(crlfResult.tasks.length).toBe(lfResult.tasks.length);
      expect(crlfResult.activities.length).toBe(lfResult.activities.length);
      expect(crlfResult.tasks).toEqual(lfResult.tasks);
      expect(crlfResult.activities).toEqual(lfResult.activities);
      expect(crlfResult.currentActivity).toEqual(lfResult.currentActivity);
      expect(crlfResult.currentTaskId).toBe(lfResult.currentTaskId);
      expect(crlfResult.depth).toBe(lfResult.depth);
    });
  }
});
