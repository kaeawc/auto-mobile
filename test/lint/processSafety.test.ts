import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  checkProcessSafetyAllowlist,
  PROCESS_SAFETY_ALLOWLIST,
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
    'pid=$!\npkill -TERM -P "$pid"',
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

  const stubs = `setup() {
  for tool in pkill killall pgrep ps; do
    cat > "\${STUB_BIN}/\${tool}" <<'STUB'
#!/bin/bash
exit 1
STUB
  done
  kill() { return 1; }
  export -f kill
  export PATH="\${STUB_BIN}:\${PATH}"
}`;
  test("uninstall invocation and sourcing require all stubs and setup PATH", () => {
    for (const command of [
      "bash scripts/uninstall.sh --all --force",
      "source scripts/clean-env-uninstall.sh",
    ]) {
      expect(checkProcessSafetySource("test/bats/fixture.bats", command)).toHaveLength(1);
      expect(checkProcessSafetySource("test/bats/fixture.bats", `${command}\n${stubs}`)).toEqual(
        [],
      );
      expect(checkProcessSafetySource("test/bats/fixture.bats", command, [stubs])).toEqual([]);
      expect(
        checkProcessSafetySource("test/bats/fixture.bats", `${command}\n# pkill() { return 1; }`),
      ).toHaveLength(1);
      expect(
        checkProcessSafetySource(
          "test/bats/fixture.bats",
          `${command}\n${stubs.replace("pgrep ps", "pgrep")}`,
        ),
      ).toHaveLength(1);
      expect(
        checkProcessSafetySource(
          "test/bats/fixture.bats",
          `${command}\n${stubs.replace("export PATH=", "# export PATH=")}`,
        ),
      ).toHaveLength(1);
      expect(
        checkProcessSafetySource(
          "test/bats/fixture.bats",
          `${command}\n${stubs.replace("export -f kill", "# export -f kill")}`,
        ),
      ).toHaveLength(1);
      expect(
        checkProcessSafetySource(
          "test/bats/fixture.bats",
          `${command}\n${stubs.replace('PATH="\${STUB_BIN}', 'PATH="\${OTHER_BIN}')}`,
        ),
      ).toHaveLength(1);
    }
  });

  test.each([
    "env pkill -f x",
    "env -i FOO=1 pkill -f x",
    "nohup pkill -f x",
    "timeout 5 pkill -f x",
    "xargs pkill -f x",
    "xargs -r killall x",
    "FOO=1 pkill -f x",
    "command -p pkill -f x",
    "sudo -n pkill -f x",
    "P=pkill; $P -f x",
    'P=pkill; "$P" -f x',
    "P=killall; ${P} x",
    '"pkill" -f x',
    "'pkill' -f x",
    "pkill -f daemon -P 1",
    "pkill -P 1",
    'pkill -P "$pid"',
    'pid=$!; pkill -f daemon -P "$pid"',
    "ps aux | grep daemon | awk '{print $2}' | xargs kill",
    "kill $(ps -ef | grep auto-mobile | awk '{print $2}')",
    "pids=$(ps aux | grep daemon | awk '{print $2}'); printf '%s' \"$pids\" | xargs -r kill",
    `pids="$(ps aux | grep daemon | awk '{print $2}')"; kill "$pids"`,
    "env --unset X nohup timeout --signal TERM 5 pkill -f x",
    'time -f "%e" pkill -f x',
    'echo "<<STUB"; pkill -f daemon',
    'echo \"pkill\"; /usr/bin/killall x',
    'echo pid=$!; pkill -P "$pid"',

    "pids=$(ps -ef | grep daemon | awk '{print $2}'); kill $pids",
    "pids=$(ps -ef | awk '/daemon/ {print $2}'); printf '%s' \"$pids\" | xargs -r kill",
    "exec time nice -n 5 timeout -s TERM 5 env pkill -f x",
    "true; then pkill -f x; else killall x",
    "kill `pgrep daemon`",
  ])("rejects structural bypass %s", (source) => {
    expect(checkProcessSafetySource(fixture, source).length).toBeGreaterThan(0);
  });

  test.each([
    "echo pkill",
    'printf "%s" "pkill -f daemon"',
    "grep 'pkill' fixtures",
    "ps -p $pid -o command=; kill $pid",
    "ps -p $pid; grep foo file; kill $pid",
    "command -v pkill",
    "# source scripts/uninstall.sh",
    "pkill -P $$",
    'pid=$!; pkill -TERM -P "$pid"',
    'pid=$$; pkill -KILL -P "${pid}"',
    "pkill -P $BASHPID",
  ])("accepts data and owned child scope %s", (source) => {
    expect(checkProcessSafetySource(fixture, source)).toEqual([]);
  });

  test("benchmark function-argument and installer recursive child forms pass", () => {
    expect(
      checkProcessSafetySource(
        "scripts/benchmark-startup.sh",
        'local pid="$1"; pkill -TERM -P "$pid"',
      ),
    ).toEqual([]);
    expect(
      checkProcessSafetySource(fixture, 'global_timeout_pid=$!; pkill -P "$global_timeout_pid"'),
    ).toEqual([]);
    expect(
      checkProcessSafetySource(
        "scripts/install.sh",
        'local pid="$1"; pgrep -P "${pid}" .; kill -KILL "${pid}"',
      ),
    ).toEqual([]);
    expect(
      checkProcessSafetySource("scripts/benchmark-startup.sh", 'pkill -f daemon -P "$pid"'),
    ).toHaveLength(1);
  });

  test("stale allowlist entries fail the tree's allowlist check", () => {
    const sources = new Map(
      Object.keys(PROCESS_SAFETY_ALLOWLIST).map((file) => [file, readFileSync(file, "utf8")]),
    );
    expect(checkProcessSafetyAllowlist(sources)).toEqual([]);
    sources.set("scripts/install.sh", '# pgrep -P "${pid}"\ntrue');
    expect(checkProcessSafetyAllowlist(sources)).toHaveLength(1);
  });

  test.each(["desktop-app", "firebender-config", "remove-from-json-config", "stop-daemon"])(
    "real uninstall-%s BATS file exists and passes",
    (name) => {
      const file = `test/bats/uninstall-${name}.bats`;
      expect(checkProcessSafetySource(file, readFileSync(file, "utf8"))).toEqual([]);
    },
  );

  test("real scripts and BATS tree satisfy the guard", () => {
    expect(checkProcessSafetyTree()).toEqual([]);
  });
});
