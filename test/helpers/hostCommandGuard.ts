import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import childProcessModule from "node:child_process";

// Fake-only scenario guard: refuse and record every host process launch for a test file.

const CHILD_PROCESS_LAUNCHERS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

export interface HostCommandGuard {
  /** Every host command something tried to launch while the guard was installed. */
  readonly commands: string[];
  restore(): void;
}

/**
 * Refuse and record every host process launch (adb, xcrun, anything) for the length of a
 * scenario: the scenarios are fake-only, so one launch is a failure. Installed on the
 * `node:child_process` module object and on `Bun.spawn`/`Bun.spawnSync`; a launch throws before
 * anything runs, and the scenario's afterEach asserts the record is empty in case a caller
 * swallowed the throw.
 */
export function guardHostCommands(): HostCommandGuard {
  const commands: string[] = [];
  const refuse = (launcher: string) =>
    function refused(...args: unknown[]): never {
      // The argv only: options carry the whole environment.
      const [first, second] = args;
      const argv =
        typeof first === "object" && first !== null
          ? (Reflect.get(first, "cmd") ?? first)
          : [first, ...(Array.isArray(second) ? second : [])];
      const command = `${launcher} ${JSON.stringify(argv)}`;
      commands.push(command);
      throw new Error(`scenario launched a host command: ${command}`);
    };
  // The default export is the mutable CJS module object (the named namespace is frozen).
  const childProcess: Record<string, unknown> = childProcessModule;
  const bun: Pick<typeof Bun, "spawn" | "spawnSync"> = Bun;
  const saved: Array<[Record<string, unknown>, string, unknown]> = [
    ...CHILD_PROCESS_LAUNCHERS.map((name): [Record<string, unknown>, string, unknown] => [
      childProcess,
      name,
      childProcess[name],
    ]),
    [bun, "spawn", bun.spawn],
    [bun, "spawnSync", bun.spawnSync],
  ];
  for (const [target, name] of saved) {
    target[name] = refuse(name);
  }
  return {
    commands,
    restore() {
      for (const [target, name, original] of saved) {
        target[name] = original;
      }
    },
  };
}

/**
 * Guard a whole test file: installed before its first hook (call this before any `beforeAll`, so
 * a warm-up scenario is covered), checked after every test, removed after the last.
 */
export function forbidHostCommands(): void {
  let guard: HostCommandGuard | undefined;
  beforeAll(() => {
    guard = guardHostCommands();
  });
  afterEach(() => {
    expect(guard?.commands).toEqual([]);
  });
  afterAll(() => {
    guard?.restore();
  });
}
