import { describe, expect, test } from "bun:test";
import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../../../src/features/toolSelection/selectionSessionResolver";

const sessions: ToolSelectionSessionManager = {
  getDeviceLabels: (sessionUuid) =>
    sessionUuid === "base-session" ? { A: "base-session", B: "base-session:B" } : undefined,
};

describe("resolveToolSelectionBaseSessionUuid", () => {
  test("resolves a known derived label without parsing unknown suffixes", () => {
    expect(resolveToolSelectionBaseSessionUuid("base-session:B", sessions)).toBe("base-session");
    expect(resolveToolSelectionBaseSessionUuid("unknown:X", sessions)).toBe("unknown:X");
  });

  test("passes through a base session, missing manager, and undefined", () => {
    expect(resolveToolSelectionBaseSessionUuid("base-session", sessions)).toBe("base-session");
    expect(resolveToolSelectionBaseSessionUuid("base-session:B", undefined)).toBe("base-session:B");
    expect(resolveToolSelectionBaseSessionUuid(undefined, sessions)).toBeUndefined();
  });
});
