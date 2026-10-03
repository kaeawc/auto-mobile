import { describe, expect, test } from "bun:test";
import {
  checkProcessSafetySource,
  checkProcessSafetyTree,
} from "../../scripts/check-process-safety";

const fixture = "scripts/fixture.sh";
describe("process safety guard", () => {
  test.each([
    'pkill -f "auto-mobile.*daemon"',
    "sudo killall auto-mobile",
    'kill $(pgrep -f "auto-mobile.*--daemon-mode")',
    "pgrep -f daemon | xargs kill -9",
    'pids=$(pgrep daemon)\nprintf "%s" "$pids" | xargs kill',
    'pids=$(pgrep -f daemon)\nkill -TERM "$pids"',
    "pkill \\\n -f daemon",
    "/usr/bin/pkill -f daemon",
    "! pkill -f daemon",
    "(pkill -f daemon)",
    'bash -c "kill $(pgrep -f daemon)"',
    "bash -c 'pkill -f daemon'",
  ])("rejects unsafe fixture %s", (source) => {
    expect(checkProcessSafetySource(fixture, source).length).toBeGreaterThan(0);
  });

  test.each([
    'pkill -TERM -P "$pid"',
    'kill -TERM "$pid"',
    'pids=$(pgrep -f daemon)\nprintf "%s" "$pids"',
    "# pkill -f daemon",
    "grep -F 'pgrep -f \"xcodebuild.*test.*CtrlProxy\"' script.sh",
  ])("accepts scoped or read-only fixture %s", (source) => {
    expect(checkProcessSafetySource(fixture, source)).toEqual([]);
  });

  test("allowlist does not permit a new pattern kill in an approved file", () => {
    expect(
      checkProcessSafetySource(
        "scripts/local-dev/hot-reload.sh",
        'pids=$(pgrep -f "auto-mobile.*--daemon-mode")\necho "$pids" | xargs kill',
      ),
    ).toHaveLength(1);
    expect(
      checkProcessSafetySource("scripts/benchmark-startup.sh", "pkill -f daemon"),
    ).toHaveLength(1);
  });

  test("an approved discovery cannot hide a pattern kill on the same line", () => {
    expect(
      checkProcessSafetySource(
        "scripts/local-dev/hot-reload.sh",
        'pids=$(pgrep -f "hot-reload.sh"); pkill -f daemon',
      ),
    ).toHaveLength(1);
  });

  test("uninstall invocation and sourcing require a local or loaded pkill stub", () => {
    for (const command of [
      "bash scripts/uninstall.sh --all --force",
      "source scripts/clean-env-uninstall.sh",
    ]) {
      expect(checkProcessSafetySource("test/bats/fixture.bats", command)).toHaveLength(1);
      expect(
        checkProcessSafetySource("test/bats/fixture.bats", `${command}\npkill() { return 1; }`),
      ).toEqual([]);
      expect(
        checkProcessSafetySource("test/bats/fixture.bats", command, ["pkill() { return 1; }"]),
      ).toEqual([]);
    }
  });

  test("real scripts and BATS tree satisfy the guard", () => {
    expect(checkProcessSafetyTree()).toEqual([]);
  });
});
