import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { readGuardFile } from "./astGuard";

const root = join(import.meta.dir, "../..");
const PLAYGROUND_REASON =
  "Playground CI assembles the app and compiles its tests; no CI unit-test task for this module today.";
const EXEMPT_MODULES: Readonly<Record<string, string>> = {
  ":ide-plugin": "Own Gradle build; bare test task runs through ci-ide-plugin-unit-tests.",
  ":playground:analytics": PLAYGROUND_REASON,
  ":playground:app": PLAYGROUND_REASON,
  ":playground:experimentation": PLAYGROUND_REASON,
  ":playground:home": PLAYGROUND_REASON,
  ":playground:login": PLAYGROUND_REASON,
  ":playground:mediaplayer": PLAYGROUND_REASON,
  ":playground:onboarding": PLAYGROUND_REASON,
  ":playground:settings": PLAYGROUND_REASON,
  ":playground:slides": PLAYGROUND_REASON,
  ":playground:storage": PLAYGROUND_REASON,
};

function collectTasks(value: unknown, tokens: Set<string>): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTasks(item, tokens);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "steps" && Array.isArray(child)) {
      for (const step of child) {
        if (typeof step !== "object" || step === null || !("with" in step)) {
          continue;
        }
        const inputs = step.with;
        if (typeof inputs !== "object" || inputs === null || !("gradle-tasks" in inputs)) {
          continue;
        }
        const tasks = inputs["gradle-tasks"];
        if (typeof tasks === "string") {
          for (const token of tasks.split(/\s+/)) {
            tokens.add(token);
          }
        }
      }
    }
    collectTasks(child, tokens);
  }
}

test("included Android modules with unit tests have an explicit CI task or reasoned exemption", () => {
  const modules = [
    ...readGuardFile(join(root, "android/settings.gradle.kts")).matchAll(
      /^include\("(:[\w:-]+)"\)$/gm,
    ),
  ].map((match) => match[1]);
  expect(modules.length).toBeGreaterThanOrEqual(10);
  const tokens = new Set<string>();
  for (const pattern of [".github/workflows/*.yml", ".github/actions/**/action.yml"]) {
    // `.github` is a dot directory: Bun.Glob skips it without `dot: true` on some versions (#15279).
    const files = [...new Bun.Glob(pattern).scanSync({ cwd: root, dot: true })];
    expect(files.length, `No files matched ${pattern}`).toBeGreaterThan(0);
    for (const file of files) {
      collectTasks(load(readGuardFile(join(root, file))), tokens);
    }
  }
  const covered = (module: string) =>
    [":test", ":testDebugUnitTest", ":check"].some((task) => tokens.has(`${module}${task}`));
  for (const [module, reason] of Object.entries(EXEMPT_MODULES)) {
    expect(modules).toContain(module);
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(covered(module), `Remove obsolete exemption for ${module}`).toBe(false);
  }
  const missing = modules.filter(
    (module) =>
      existsSync(join(root, "android", module.slice(1).replaceAll(":", "/"), "src/test")) &&
      !covered(module) &&
      !Object.hasOwn(EXEMPT_MODULES, module),
  );
  expect(missing, `Missing CI unit-test tasks: ${missing.join(", ")}`).toEqual([]);
});
