import { describe, expect, test } from "bun:test";
import { findToolDefinitionsDrift } from "../../scripts/lib/toolDefinitionsDrift";

describe("findToolDefinitionsDrift", () => {
  test("reports added, removed, and changed tool names", () => {
    const result = findToolDefinitionsDrift(
      [
        { name: "same", inputSchema: { type: "object" } },
        { name: "changed", description: "old" },
        { name: "removed" },
      ],
      [
        { name: "same", inputSchema: { type: "object" } },
        { name: "changed", description: "new" },
        { name: "added" },
      ],
    );

    expect(result).toEqual({
      added: ["added"],
      removed: ["removed"],
      changed: ["changed"],
      invalidCommittedDefinitions: false,
    });
  });

  test("treats identical definitions with different object key order as equal", () => {
    const result = findToolDefinitionsDrift(
      [{ name: "sample", description: "text", inputSchema: { type: "object", title: "T" } }],
      [{ inputSchema: { title: "T", type: "object" }, name: "sample", description: "text" }],
    );

    expect(result).toEqual({
      added: [],
      removed: [],
      changed: [],
      invalidCommittedDefinitions: false,
    });
  });

  test("treats non-array committed definitions as drift", () => {
    expect(findToolDefinitionsDrift({ name: "sample" }, [])).toEqual({
      added: [],
      removed: [],
      changed: [],
      invalidCommittedDefinitions: true,
    });
  });
});
