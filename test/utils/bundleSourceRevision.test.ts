import { describe, expect, test } from "bun:test";
import {
  readBundleSourceRevision,
  type InfoPlistReader,
} from "../../src/utils/bundleSourceRevision";

function reader(result: unknown | Error): InfoPlistReader & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    readJsonFile: async (path: string) => {
      paths.push(path);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

describe("readBundleSourceRevision (#16954)", () => {
  test("reads the declared branch and sha from the bundle's Info.plist", async () => {
    const plist = reader({
      CFBundleVersion: "42",
      "dev.jasonpearson.automobile.build.gitBranch": "release/1.2",
      "dev.jasonpearson.automobile.build.gitSha": "0123456789abcdef",
    });
    expect(await readBundleSourceRevision(plist, "/apps/App.app")).toEqual({
      gitBranch: "release/1.2",
      gitSha: "0123456789abcdef",
    });
    expect(plist.paths).toEqual(["/apps/App.app/Info.plist"]);
  });

  test("old builds without the keys, invalid values and read failures yield no revision", async () => {
    expect(
      await readBundleSourceRevision(reader({ CFBundleVersion: "42" }), "/a.app"),
    ).toBeUndefined();
    expect(
      await readBundleSourceRevision(
        reader({ "dev.jasonpearson.automobile.build.gitBranch": "main" }),
        "/a.app",
      ),
    ).toBeUndefined();
    expect(await readBundleSourceRevision(reader(new Error("no file")), "/a.app")).toBeUndefined();
    expect(await readBundleSourceRevision(reader(["not", "a", "dict"]), "/a.app")).toBeUndefined();
  });

  test("an unknown bundle path is never read", async () => {
    const plist = reader({});
    expect(await readBundleSourceRevision(plist, "")).toBeUndefined();
    expect(plist.paths).toEqual([]);
  });
});
