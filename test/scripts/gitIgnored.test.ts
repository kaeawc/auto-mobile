import { describe, expect, test } from "bun:test";
import { dropGitIgnored } from "../../scripts/lib/gitIgnored";

describe("dropGitIgnored", () => {
  test("drops the paths git reports as ignored and keeps the rest", () => {
    const seen: string[] = [];
    const kept = dropGitIgnored("/repo", ["docs/changelog.md", "docs/index.md"], (root, input) => {
      seen.push(root, input);
      return { status: 0, stdout: "docs/changelog.md\0" };
    });
    expect(kept).toEqual(["docs/index.md"]);
    expect(seen).toEqual(["/repo", "docs/changelog.md\0docs/index.md"]);
  });

  test("keeps everything when git reports nothing ignored", () => {
    expect(dropGitIgnored("/repo", ["docs/index.md"], () => ({ status: 1, stdout: "" }))).toEqual([
      "docs/index.md",
    ]);
  });

  test("keeps everything when git cannot decide", () => {
    expect(
      dropGitIgnored("/repo", ["docs/changelog.md"], () => ({ status: 128, stdout: "" })),
    ).toEqual(["docs/changelog.md"]);
    expect(
      dropGitIgnored("/repo", ["docs/changelog.md"], () => ({ status: null, stdout: "" })),
    ).toEqual(["docs/changelog.md"]);
  });
});
