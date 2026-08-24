import { describe, expect, test } from "bun:test";
import { collectNavFiles } from "../../scripts/validate-mkdocs-nav";

describe("collectNavFiles", () => {
  test("collects nested and quoted-equivalent YAML nav targets structurally", () => {
    expect(
      collectNavFiles([
        { Overview: "index.md" },
        { Guides: [{ Advanced: "guides/advanced.md" }] },
        { External: "https://example.com" },
      ]),
    ).toEqual(["index.md", "guides/advanced.md"]);
  });
});
