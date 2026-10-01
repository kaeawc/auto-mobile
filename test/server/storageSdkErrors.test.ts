import { describe, expect, test } from "bun:test";
import {
  IOS_STORAGE_MUTATION_AUTHORIZATION_HINT,
  mapStorageSdkError,
} from "../../src/server/storageSdkErrors";

describe("storage SDK error mapping", () => {
  test("invalid suite errors explain standard aliases and suite validity", () => {
    const message = mapStorageSdkError(
      new Error("iOS key-value storage rejected the value: invalid_store_name"),
      { operation: "storage" },
    );
    expect(message).toContain("invalid_store_name");
    expect(message).toContain("bundle id");
    expect(message).toContain("no leading or trailing whitespace");
    expect(message).toContain("global domain is not allowed");
  });

  test("failed write verification explains read-back failure", () => {
    const message = mapStorageSdkError(
      new Error("iOS key-value storage failed: write_verification_failed"),
      { operation: "storage" },
    );
    expect(message).toContain("write_verification_failed");
    expect(message).toContain("requested mutation in the store's persistent domain");
  });

  test.each([
    ["set", "absent or its value or type did not match"],
    ["remove", "key was still present"],
    ["clear", "prior keys were still present"],
  ] as const)(
    "verification failure names %s and its persistent-domain condition",
    (action, detail) => {
      const message = mapStorageSdkError(new Error("write_verification_failed"), {
        operation: "storage",
        action,
      });
      expect(message).toContain(`confirm the ${action} in the store's persistent domain`);
      expect(message).toContain("write_verification_failed");
      expect(message).toContain(detail);
    },
  );

  test("mutation authorization retains shared guidance", () => {
    expect(
      mapStorageSdkError(
        new Error("iOS key-value storage mutation is not authorized: mutation_not_authorized"),
        { operation: "storage" },
      ),
    ).toBe(IOS_STORAGE_MUTATION_AUTHORIZATION_HINT);
  });

  test.each(["unknown_code", "encode_failed", "plain message"])(
    "storage leaves unrelated errors unmapped: %s",
    (message) => {
      expect(mapStorageSdkError(new Error(message), { operation: "storage" })).toBeNull();
    },
  );

  test("database mapping retains the requested path", () => {
    expect(
      mapStorageSdkError(new Error("unknown_database_path"), {
        operation: "database",
        databasePath: "/app/notes.db",
      }),
    ).toContain("/app/notes.db");
  });
});
