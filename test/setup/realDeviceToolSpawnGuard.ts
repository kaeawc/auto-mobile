/** Unit-only process boundary. No I/O or process access: the preload supplies both. */
const BLOCKED_TOOLS = new Set([
  "adb",
  "xcrun",
  "xcodebuild",
  "simctl",
  "devicectl",
  "emulator",
  "avdmanager",
  "sdkmanager",
  "ffmpeg",
  "curl",
]);
const GUARD_MARKER = Symbol("realDeviceToolSpawnGuard");
type SpawnFunction = (...args: never[]) => unknown;

export interface SpawnTarget {
  spawn: SpawnFunction;
  spawnSync: SpawnFunction;
}

export interface Violation {
  testFile: string;
  tool: string;
  argv: readonly string[];
}

export interface SpawnGuardDependencies {
  target: SpawnTarget;
  testFile: string;
  loadAllowList: () => ReadonlySet<string>;
  mode: "enforce" | "census";
  record?: (tool: string, argv: readonly string[]) => void;
  report: Violation[];
}

export function isUnitTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.endsWith(".test.ts") &&
    !normalized.endsWith(".integration.test.ts") &&
    !normalized.startsWith("test/stress/") &&
    !normalized.includes("/test/stress/")
  );
}

function executableName(value: string): string {
  return (value.replaceAll("\\", "/").split("/").pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
}

// Deliberately a bounded shell approximation, not a shell interpreter. Quotes
// preserve spaces; operators split command segments (including quoted scripts).
function shellWords(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
    word.replace(/^(["'])(.*)\1$/, "$2"),
  );
}

export function blockedToolForArgv(argv: readonly string[]): string | undefined {
  const name = executableName(argv[0] ?? "");
  if (BLOCKED_TOOLS.has(name)) {
    return name;
  }
  if (["sh", "bash", "zsh", "dash"].includes(name)) {
    const flag = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    return flag < 0 ? undefined : blockedShellCommand(argv[flag + 1] ?? "");
  }
  if (name === "cmd") {
    const flag = argv.findIndex((arg) => arg.toLowerCase() === "/c");
    return flag < 0 ? undefined : blockedShellCommand(argv.slice(flag + 1).join(" "));
  }
  if (["which", "where"].includes(name)) {
    return argv
      .slice(1)
      .filter((arg) => !arg.startsWith("-"))
      .map(executableName)
      .find((tool) => BLOCKED_TOOLS.has(tool));
  }
  if (["exec", "command", "env"].includes(name) || /^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[0] ?? "")) {
    const remainder = argv.slice(name === "env" || name === "exec" || name === "command" ? 1 : 0);
    const index = remainder.findIndex(
      (arg) => !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z_0-9]*=/.test(arg),
    );
    return index < 0 ? undefined : blockedToolForArgv(remainder.slice(index));
  }
  return undefined;
}

function blockedShellCommand(command: string): string | undefined {
  for (const segment of command.split(/;|&&|\|\||\|/)) {
    const tool = blockedToolForArgv(shellWords(segment.trim()));
    if (tool) {
      return tool;
    }
  }
  return undefined;
}

export function spawnArgv(args: readonly unknown[]): readonly string[] {
  const first = args[0];
  const cmd = Array.isArray(first)
    ? first
    : first !== null && typeof first === "object" && "cmd" in first
      ? first.cmd
      : undefined;
  return Array.isArray(cmd) && cmd.every((arg) => typeof arg === "string") ? cmd : [];
}

function violationMessage(violation: Violation): string {
  return (
    `real device tool spawned: ${violation.testFile}: ${violation.argv.join(" ")} (${violation.tool}). ` +
    "Inject FakeProcessExecutor / fake adb executor / FakeDisplayInventoryProvider / " +
    "PlatformDeviceManagerFactory.setInstance. Existing exceptions live in " +
    "scripts/unit-test-device-spawn-allowlist.txt and may only shrink. " +
    "Re-run with --isolate if you ran several files without it."
  );
}

/** Fail even when child_process.spawnSync or the caller swallowed the error. */
export function drainViolations(report: Violation[]): void {
  const violations = report.splice(0);
  if (violations.length) {
    throw new Error(violations.map(violationMessage).join("\n"));
  }
}

export function installRealDeviceToolSpawnGuard(deps: SpawnGuardDependencies): () => void {
  if (!isUnitTestPath(deps.testFile)) {
    return () => {};
  }
  let allowList: ReadonlySet<string> | undefined;
  const originals = { spawn: deps.target.spawn, spawnSync: deps.target.spawnSync };
  const replacements: Partial<SpawnTarget> = {};
  for (const key of ["spawn", "spawnSync"] as const) {
    const original = originals[key];
    if (Reflect.get(original, GUARD_MARKER)) {
      continue;
    }
    const proxy = new Proxy(original, {
      get(target, property, receiver) {
        return property === GUARD_MARKER ? true : Reflect.get(target, property, receiver);
      },
      apply(target, thisArg, args: unknown[]) {
        const argv = spawnArgv(args);
        const tool = blockedToolForArgv(argv);
        if (!tool) {
          return Reflect.apply(target, thisArg, args);
        }
        if (deps.mode === "census") {
          deps.record?.(tool, argv);
          throw Object.assign(new Error(`spawn ${tool} ENOENT (unit-test census blocked launch)`), {
            code: "ENOENT",
          });
        }
        allowList ??= deps.loadAllowList();
        if (allowList.has(deps.testFile)) {
          return Reflect.apply(target, thisArg, args);
        }
        const violation = { testFile: deps.testFile, tool, argv: [...argv] };
        deps.report.push(violation);
        throw new Error(violationMessage(violation));
      },
    });
    deps.target[key] = proxy;
    replacements[key] = proxy;
  }
  return () => {
    for (const key of ["spawn", "spawnSync"] as const) {
      if (replacements[key] && deps.target[key] === replacements[key]) {
        deps.target[key] = originals[key];
      }
    }
  };
}
