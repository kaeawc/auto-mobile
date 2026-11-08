import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CTRL_PROXY_PROJECT_RELATIVE_PATH,
  locateCtrlProxyProject,
} from "../../src/ctrlProxy/CtrlProxyProjectLocator";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

test("anchors a relative project root at the daemon launch directory and dedupes candidates", async () => {
  const accesses: string[] = [];
  const location = await locateCtrlProxyProject("checkout", {
    access: async (file) => {
      accesses.push(file);
      throw new Error("ENOENT");
    },
    launchDirectory: () => path.resolve("/launch"),
    packageRoot: () => path.resolve("/launch"),
  });
  expect(location.found).toBe(false);
  expect(accesses).toEqual(location.checked);
  expect(location.checked).toHaveLength(2);
  expect(location.checked[1]).toBe(
    path.join(path.resolve("/launch"), CTRL_PROXY_PROJECT_RELATIVE_PATH),
  );
});

test("the default package root finds the checked-in project from an unrelated directory", async () => {
  const project = path.join(REPO_ROOT, CTRL_PROXY_PROJECT_RELATIVE_PATH);
  if (!existsSync(project)) {
    throw new Error(`expected the checked-in project at ${project}`);
  }
  const unrelated = path.resolve("/nonexistent-automobile-root");
  const location = await locateCtrlProxyProject(unrelated, { launchDirectory: () => unrelated });
  expect(location).toEqual({
    found: true,
    projectPath: project,
    checked: [path.join(unrelated, CTRL_PROXY_PROJECT_RELATIVE_PATH), project],
  });
});
