import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BackStackInfo, BootedDevice } from "../../../src/models";

/**
 * `GetBackStack` asserted against REAL `dumpsys activity activities` captures
 * (issue #4329).
 *
 * Every fixture under `activityActivitiesDumps/` is a verbatim capture from a
 * booted emulator -- one per supported API level 24..36, driven to a known
 * back stack (home launcher + a Settings task with depth + a second app task)
 * by `scripts/capture-activity-activities.sh`. Provenance (API level, release,
 * system image, build fingerprint) is recorded in the `#`-prefixed header of
 * each file.
 *
 * These are the FIRST real `activity activities` samples in the repo. Before
 * #4329 the only committed captures were `dumpsys window windows` output
 * (`windowDumps/`), which carries no `Task{`, `Hist #N`, or `A=`/`I=` tokens,
 * so the modern task-header and Hist-row parsing added by #4197/#4223/#4263 was
 * pinned only against AOSP-sourced, hand-authored strings. This suite replaces
 * that assumption with observation: it fails if the modern `Task{...}` header or
 * the `Hist  #N` activity row stops parsing on any real level, which is exactly
 * the "prove the fixtures are load-bearing, not decorative" requirement.
 *
 * The generic block asserts invariants that must hold on every real capture; the
 * per-level block spot-checks exact values a specific capture is known to carry.
 */

const CAPTURE_DIR = path.join(__dirname, "activityActivitiesDumps");
const device: BootedDevice = { name: "test", platform: "android", deviceId: "test-device" };

function readCapture(file: string): string {
  // Normalize CRLF -> LF. The fixtures are committed LF (and pinned `eol=lf` in
  // .gitattributes), but a Windows checkout with core.autocrlf=true can still
  // materialize them as CRLF; the parser targets the LF output a device's adb
  // emits, and its `Task{...}(.*)$` header anchor does not match a trailing \r.
  return fs.readFileSync(path.join(CAPTURE_DIR, file), "utf8").replace(/\r\n/g, "\n");
}

async function parse(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
  return new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
}

/**
 * Task ids that appear in a REAL header position -- the same three anchored
 * shapes `parseTaskHeader` accepts: modern `* Task{<hash> #id`, legacy
 * `Task id #id`, and legacy `* TaskRecord{<hash> #id`. Inline references such as
 * `rootOfTask=false task=Task{... #id}` are deliberately excluded, so a parser
 * that invented tasks from them would produce ids not in this set.
 */
function headerTaskIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const line of raw.split("\n")) {
    // Whitespace matched with `\s+` (not literal spaces) so these mirror the
    // parser's own anchoring in GetBackStack.ts exactly -- a build that printed
    // `Task id  #N` would be parsed by the parser and must be seen here too.
    const m =
      line.match(/^\s*\*\s*Task\{\S+\s+#(\d+)\b/) ||
      line.match(/^\s*Task\s+id\s+#(\d+)\b/) ||
      line.match(/^\s*\*?\s*TaskRecord\{\S+\s+#(\d+)\b/);
    if (m) {
      ids.add(parseInt(m[1], 10));
    }
  }
  return ids;
}

/**
 * The `dumpsys activity activities` TEXT format flips at API 30 (Android 11):
 * 24..29 print the legacy `Task id #N` / `* TaskRecord{...}` headers, 30..36
 * print the modern `* Task{...}` header. (The internal `TaskRecord`->`Task`
 * rename landed in Android 10/API 29, but that release still emits the legacy
 * dump layout -- a distinction only a real capture reveals.) Observed across the
 * committed captures; asserted per level below so both parser paths stay pinned
 * to real output.
 */
const MODERN_FORMAT_MIN_API = 30;

function hasModernHeader(raw: string): boolean {
  return raw.split("\n").some((l) => /^\s*\*\s*Task\{\S+\s+#\d+\b/.test(l));
}

function hasLegacyHeader(raw: string): boolean {
  return raw.split("\n").some((l) => /^\s*(?:Task id #\d+|\*?\s*TaskRecord\{\S+\s+#\d+)\b/.test(l));
}

/**
 * One `Hist #N` row paired with the `rootOfTask=` value printed inside its own
 * `ActivityRecord` block (issue #4340). Extracted from the raw capture by an
 * independent scan so the parser's `isTaskRoot` can be asserted against the
 * dump's own ground truth rather than against the Hist-index heuristic.
 */
interface HistGroundTruth {
  histIndex: number;
  /** Verbatim "pkg/.Cls" from the Hist row. */
  component: string;
  /** The block's own `rootOfTask=` value; absent on API <= 29 captures. */
  rootOfTask?: boolean;
}

function histGroundTruth(raw: string): HistGroundTruth[] {
  const rows: HistGroundTruth[] = [];
  for (const line of raw.split("\n")) {
    const hist = line.match(/\bHist\s+#(\d+):\s+ActivityRecord\{\S+\s+u\d+\s+([^\s}]+)/);
    if (hist) {
      rows.push({ histIndex: parseInt(hist[1], 10), component: hist[2] });
      continue;
    }
    // Anchored to the start of the line: `rootOfTask=` is printed as its own
    // field line inside the ActivityRecord block, always after its Hist row.
    const root = line.match(/^\s*rootOfTask=(true|false)\b/);
    if (root && rows.length > 0) {
      rows[rows.length - 1].rootOfTask = root[1] === "true";
    }
  }
  return rows;
}

/** "pkg/.Cls" -> fully-qualified class name, mirroring the parser's own rule. */
function qualify(component: string): string {
  const [pkg, cls] = component.split("/");
  return cls.startsWith(".") ? pkg + cls : cls;
}

/** All `apiNN-*.log` captures, sorted by API level for stable test ordering. */
const captureFiles = fs.existsSync(CAPTURE_DIR)
  ? fs
      .readdirSync(CAPTURE_DIR)
      // Match the `apiNN-` naming, not just `.log`, so a stray non-capture file
      // fails the coverage assertion cleanly rather than throwing on the
      // `.match(/api(\d+)/)!` below.
      .filter((f) => /^api\d+.*\.log$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/api(\d+)/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/api(\d+)/)?.[1] ?? "0", 10);
        return na - nb;
      })
  : [];

describe("GetBackStack against real captures (#4329)", () => {
  test("the capture directory is populated", () => {
    // A green suite with zero fixtures would be vacuous. Fail loudly instead.
    expect(captureFiles.length).toBeGreaterThan(0);
  });

  test("covers every supported API level 24..36", () => {
    const levels = captureFiles
      .map((f) => parseInt(f.match(/api(\d+)/)![1], 10))
      .sort((a, b) => a - b);
    const expected = Array.from({ length: 36 - 24 + 1 }, (_, i) => 24 + i);
    expect(levels).toEqual(expected);
  });

  test("the corpus exercises BOTH the legacy and modern header formats", () => {
    // Guards against a future edit that deletes all of one era's captures and
    // silently stops covering that parser path.
    const anyLegacy = captureFiles.some((f) => hasLegacyHeader(readCapture(f)));
    const anyModern = captureFiles.some((f) => hasModernHeader(readCapture(f)));
    expect(anyLegacy).toBe(true);
    expect(anyModern).toBe(true);
  });

  for (const file of captureFiles) {
    const apiLevel = parseInt(file.match(/api(\d+)/)?.[1] ?? "0", 10);

    describe(`${file} (API ${apiLevel})`, () => {
      test("parses at least one real task", async () => {
        const result = await parse(readCapture(file));
        expect(result.tasks.length).toBeGreaterThan(0);
        for (const task of result.tasks) {
          expect(Number.isInteger(task.id)).toBe(true);
          expect(task.id).toBeGreaterThan(0);
        }
      });

      test("invents no task from an inline task=Task{...} reference", async () => {
        const raw = readCapture(file);
        const result = await parse(raw);
        const headers = headerTaskIds(raw);
        // Every parsed task id must trace back to a real anchored header line.
        for (const task of result.tasks) {
          expect(headers.has(task.id)).toBe(true);
        }
      });

      test("resolves the foreground activity to a real component", async () => {
        const raw = readCapture(file);
        const result = await parse(raw);
        expect(result.currentActivity).toBeDefined();
        expect(result.currentActivity!.name.length).toBeGreaterThan(0);
        // The resolved current activity's simple/class name must actually occur
        // in the dump -- not be an artifact of a mis-anchored regex.
        expect(raw).toContain(result.currentActivity!.name.split(".").pop()!);
      });

      test("marks at least one activity as the task root", async () => {
        const result = await parse(readCapture(file));
        expect(result.activities.length).toBeGreaterThan(0);
        expect(result.activities.some((a) => a.isTaskRoot === true)).toBe(true);
      });

      test("never glues a brace or whitespace onto an activity component", async () => {
        // The API 33 shape closes the component with its own "}" before the task
        // id; a component ending in "}" means the brace-stripping regressed.
        const result = await parse(readCapture(file));
        for (const activity of result.activities) {
          expect(activity.name).not.toContain("}");
          expect(activity.name).not.toContain("{");
          expect(activity.name.trim()).toBe(activity.name);
          expect(activity.name.length).toBeGreaterThan(0);
        }
      });

      test("gives every activity a task id carried by a real task", async () => {
        const raw = readCapture(file);
        const result = await parse(raw);
        const headers = headerTaskIds(raw);
        for (const activity of result.activities) {
          expect(activity.taskId).toBeGreaterThan(0);
          expect(headers.has(activity.taskId)).toBe(true);
        }
      });

      if (apiLevel >= MODERN_FORMAT_MIN_API) {
        test("isTaskRoot matches the dump's own rootOfTask field (#4340)", async () => {
          const raw = readCapture(file);
          const truth = histGroundTruth(raw);
          // Every modern capture pairs each Hist row with exactly one
          // rootOfTask= line; a hole here means the extraction regressed, not
          // the parser.
          expect(truth.length).toBeGreaterThan(0);
          for (const row of truth) {
            expect(row.rootOfTask).toBeDefined();
          }
          const result = await parse(raw);
          expect(
            result.activities.map((a) => ({ name: a.name, isTaskRoot: a.isTaskRoot })),
          ).toEqual(truth.map((r) => ({ name: qualify(r.component), isTaskRoot: r.rootOfTask! })));
        });
      } else {
        test("no rootOfTask printed; isTaskRoot stays index-derived (#4340)", async () => {
          const raw = readCapture(file);
          expect(raw).not.toContain("rootOfTask=");
          const truth = histGroundTruth(raw);
          const result = await parse(raw);
          expect(result.activities.map((a) => a.isTaskRoot)).toEqual(
            truth.map((r) => r.histIndex === 0),
          );
        });
      }

      if (readCapture(file).includes("rootOfTask=")) {
        test("tasks[].rootActivity agrees with the activity marked isTaskRoot (#4359)", async () => {
          // Cross-consistency: whichever activity `activities[]` reports as the
          // task root (driven by the block's own rootOfTask= field since #4357)
          // must be the same component `tasks[].rootActivity` names for that
          // task. Before #4359, parseTasks resolved rootActivity from the first
          // `Hist #0` row, which can name an activity the dump says is NOT the
          // root (api34 task #9). Scoped to tasks that actually carry a marked
          // root activity -- container tasks with no Hist rows leave rootActivity
          // undefined, which this invariant cannot speak to.
          const result = await parse(readCapture(file));
          const rootByTask = new Map<number, string>();
          for (const activity of result.activities) {
            if (activity.isTaskRoot) {
              rootByTask.set(activity.taskId, activity.name);
            }
          }
          for (const task of result.tasks) {
            const markedRoot = rootByTask.get(task.id);
            if (markedRoot === undefined || task.rootActivity === undefined) {
              continue;
            }
            expect(qualify(task.rootActivity)).toBe(markedRoot);
          }
        });
      }

      test("parses tasks via the header format this level actually emits", async () => {
        // Ties each level to the parser path it exercises: a modern-format level
        // whose `* Task{...}` parsing regressed, or a legacy-format level whose
        // `TaskRecord{...}`/`Task id #` parsing regressed, would yield zero tasks
        // and fail here. This is what makes the real captures load-bearing.
        const raw = readCapture(file);
        const result = await parse(raw);
        if (apiLevel >= MODERN_FORMAT_MIN_API) {
          expect(hasModernHeader(raw)).toBe(true);
          expect(hasLegacyHeader(raw)).toBe(false);
        } else {
          expect(hasLegacyHeader(raw)).toBe(true);
          expect(hasModernHeader(raw)).toBe(false);
        }
        expect(result.tasks.length).toBeGreaterThan(0);
      });
    });
  }

  // Exact spot-checks against two representative captures. Values are copied
  // from the committed (immutable) fixtures, so they pin real, observed output
  // rather than an assumed shape.
  describe("api24 legacy capture, exact values", () => {
    test("parses the driven home + settings + contacts back stack", async () => {
      const result = await parse(readCapture("api24-home-settings-secondapp.log"));

      expect(result.currentActivity?.name).toBe("com.android.contacts.activities.PeopleActivity");
      expect(result.currentTaskId).toBe(5);
      // Contacts (foreground), Settings, and the launcher -- three real tasks.
      expect(result.tasks.map((t) => t.rootActivity)).toEqual([
        "com.android.contacts/.activities.PeopleActivity",
        "com.android.settings/.Settings",
        "com.android.launcher3/.Launcher",
      ]);
    });

    test("legacy A= affinity is NOT uid-prefixed (bare package)", async () => {
      const result = await parse(readCapture("api24-home-settings-secondapp.log"));
      // Pre-Android-11 affinity is the bare package; contrast api34 below.
      expect(result.tasks[1].affinity).toBe("com.android.settings");
    });
  });

  // Both directions the Hist-index heuristic got wrong (issue #4340), pinned
  // against the exact fixtures the issue reproduced them on.
  describe("isTaskRoot vs rootOfTask, exact values (#4340)", () => {
    for (const file of ["api35-home-settings-secondapp.log", "api36-home-settings-secondapp.log"]) {
      test(`${file}: launcher prints as Hist #1 yet IS the task root`, async () => {
        const result = await parse(readCapture(file));
        const launcher = result.activities.find(
          (a) => a.name === "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
        );
        expect(launcher).toBeDefined();
        expect(launcher!.isTaskRoot).toBe(true);
      });
    }

    test("api34: WifiSettingsActivity prints as Hist #0 yet is NOT the task root", async () => {
      const result = await parse(readCapture("api34-home-settings-secondapp.log"));
      const wifi = result.activities.find(
        (a) => a.name === "com.android.settings.Settings$WifiSettingsActivity",
      );
      expect(wifi).toBeDefined();
      expect(wifi!.isTaskRoot).toBe(false);
    });
  });

  // AC1: parseTasks must resolve rootActivity from the Hist row the dump marks
  // rootOfTask=true, not the first `Hist #0` row (issue #4359). Task #9 prints
  // two `Hist #0` rows in different TaskFragments; the first (Wifi) says
  // rootOfTask=false, the second (DeepLinkHomepage) says true.
  describe("api34 task #9 rootActivity prefers rootOfTask=true (#4359)", () => {
    test("rootActivity names DeepLinkHomepageActivity, not the first Hist #0 Wifi row", async () => {
      const result = await parse(readCapture("api34-home-settings-secondapp.log"));
      const task9 = result.tasks.find((t) => t.id === 9);
      expect(task9).toBeDefined();
      expect(task9!.rootActivity).toBe("com.android.settings/.homepage.DeepLinkHomepageActivity");
      // packageName is unaffected -- both Hist #0 rows are com.android.settings.
      expect(task9!.packageName).toBe("com.android.settings");
    });
  });

  // AC2: API <= 29 fixtures print no rootOfTask= field, so the first-`Hist #0`
  // fallback stays the only source; their rootActivity values must not move
  // (issue #4359). Pinned to the exact values the committed captures carry.
  describe("API <= 29 rootActivity is unchanged (#4359)", () => {
    const BASELINE: Record<string, Array<[number, string]>> = {
      "api24-home-settings-secondapp.log": [
        [5, "com.android.contacts/.activities.PeopleActivity"],
        [4, "com.android.settings/.Settings"],
        [3, "com.android.launcher3/.Launcher"],
      ],
      "api25-home-settings-secondapp.log": [
        [8, "com.android.contacts/.activities.PeopleActivity"],
        [7, "com.android.settings/.Settings$WifiSettingsActivity"],
        [6, "com.android.settings/.Settings"],
        [5, "com.android.launcher3/.Launcher"],
      ],
      "api26-home-settings-secondapp.log": [
        [8, "com.android.contacts/.activities.PeopleActivity"],
        [7, "com.android.settings/.Settings$WifiSettingsActivity"],
        [6, "com.android.settings/.Settings"],
        [5, "com.google.android.apps.nexuslauncher/.NexusLauncherActivity"],
      ],
      "api27-home-settings-secondapp.log": [
        [8, "com.android.contacts/.activities.PeopleActivity"],
        [7, "com.android.settings/.Settings$WifiSettingsActivity"],
        [6, "com.android.settings/.Settings"],
        [5, "com.google.android.apps.nexuslauncher/.NexusLauncherActivity"],
      ],
      "api28-home-settings-secondapp.log": [
        [8, "com.android.contacts/.activities.PeopleActivity"],
        [7, "com.android.settings/.Settings$WifiSettingsActivity"],
        [6, "com.android.settings/.Settings"],
        [5, "com.android.launcher3/.Launcher"],
      ],
      "api29-home-settings-secondapp.log": [
        [7, "com.android.contacts/.activities.PeopleActivity"],
        [6, "com.android.settings/.homepage.SettingsHomepageActivity"],
        [5, "com.google.android.apps.nexuslauncher/.NexusLauncherActivity"],
      ],
    };

    for (const [file, expected] of Object.entries(BASELINE)) {
      test(`${file} keeps its rootActivity values`, async () => {
        const raw = readCapture(file);
        // Guard the premise: these levels genuinely print no rootOfTask= field.
        expect(raw).not.toContain("rootOfTask=");
        const result = await parse(raw);
        for (const [id, rootActivity] of expected) {
          const task = result.tasks.find((t) => t.id === id);
          expect(task?.rootActivity).toBe(rootActivity);
        }
      });
    }
  });

  describe("api34 modern capture, exact values", () => {
    test("parses the modern Task{...} headers and uid-prefixed affinity", async () => {
      const result = await parse(readCapture("api34-home-settings-secondapp.log"));

      const settings = result.tasks.find((t) => t.packageName === "com.android.settings");
      expect(settings).toBeDefined();
      // Android 11+ prepends the uid to Task.affinity (b/35954083); observed
      // verbatim here as `A=1000:com.android.settings`.
      expect(settings!.affinity).toBe("1000:com.android.settings");
    });

    test("resolves the foreground contacts activity and its task", async () => {
      const result = await parse(readCapture("api34-home-settings-secondapp.log"));

      expect(result.currentActivity?.name).toBe(
        "com.google.android.apps.contacts.activities.OnboardingSignInActivity",
      );
      expect(result.currentTaskId).toBe(10);
    });
  });
});
