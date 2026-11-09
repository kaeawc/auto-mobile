import { describe, expect, test } from "bun:test";
import {
  type RunnerSources,
  newHostGates,
  newRunnerCapabilities,
  unreleasedRunnerCapabilitiesInUse,
} from "../../scripts/release/lib/runner-capability-note";

const unchangedIos = { base: 'case a = "ios_a_v1"', current: 'case a = "ios_a_v1"' };

function sources(androidBase: string, androidCurrent: string): RunnerSources {
  return {
    "android-ctrlproxy-apk": { base: androidBase, current: androidCurrent },
    "ios-runner": unchangedIos,
  };
}

describe("newRunnerCapabilities", () => {
  test("reports only capabilities the working tree newly advertises", () => {
    expect(
      newRunnerCapabilities(sources('add("old_v1")', 'add("old_v1")\nadd("fresh_v1")')),
    ).toEqual(["fresh_v1"]);
  });

  test("a moved advertisement is not new", () => {
    expect(newRunnerCapabilities(sources('add("old_v1")', '// moved\nadd("old_v1")'))).toEqual([]);
  });
});

describe("newHostGates", () => {
  test("counts literals and referenced constants, never comments", () => {
    expect(
      newHostGates([
        {
          base: "",
          current:
            'const A = "a_v1";\nsupports(A);\nsupports(\'b_v1\');\n// "c_v1"\nconst D = "d_v1";',
        },
      ]),
    ).toEqual(["a_v1", "b_v1"]);
  });

  test("gates already present at the base are not new", () => {
    expect(newHostGates([{ base: 'supports("a_v1");', current: 'supports("a_v1");\n' }])).toEqual(
      [],
    );
  });
});

describe("unreleasedRunnerCapabilitiesInUse", () => {
  test("intersects new runner capabilities with new host gates", () => {
    expect(
      unreleasedRunnerCapabilitiesInUse(sources("", 'add("fresh_v1")\nadd("unused_v1")'), [
        { base: "", current: 'supports("fresh_v1");\nsupports("old_v1");' },
      ]),
    ).toEqual(["fresh_v1"]);
  });
});
