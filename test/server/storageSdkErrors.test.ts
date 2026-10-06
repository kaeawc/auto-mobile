import { describe, expect, test } from "bun:test";
import {
  IOS_STORAGE_MUTATION_AUTHORIZATION_HINT,
  mapStorageSdkError,
  iosSqlErrorMessage,
  iosStorageErrorMessage,
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

// Failure strings from CommandHandler's foreground gates, SdkDatabaseClient.requestData,
// SdkHierarchyServer.requireApplicationActive, and IOSCtrlProxyClient.sdkUnavailableResult.
const sdkPrefix =
  "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)";
const foregroundMessage =
  "The target app is not in the foreground; bring it to the foreground and retry.";
const capabilityMessage =
  "Failed to execute SQL on iOS. The target app is either not in the foreground (bring it to the foreground and retry) or does not embed the AutoMobile SDK in a DEBUG build with DatabaseInspector.shared.setEnabled(true).";
const storageCapabilityMessage =
  "The target app is either not in the foreground (bring it to the foreground and retry) or does not embed the AutoMobile SDK in a DEBUG build with DatabaseInspector.shared.setEnabled(true).";

test("shared capability absence guidance has no SQL prefix", () => {
  expect(
    iosStorageErrorMessage(
      new Error("The foreground iOS app does not expose the AutoMobile SDK capability database."),
    ),
  ).toBe(storageCapabilityMessage);
});

test.each(["storage", "database"] as const)(
  "capability absence guidance has no SQL prefix for %s operations",
  (operation) => {
    expect(
      mapStorageSdkError(
        new Error("The foreground iOS app does not expose the AutoMobile SDK capability database."),
        { operation },
      ),
    ).toBe(storageCapabilityMessage);
  },
);

test.each([
  `${sdkPrefix}: app_not_active`,
  "Database inspection requires requested appId com.example.app to be the foreground app",
  "iOS key-value storage requires com.example.app to be the foreground app",
])("maps definite foreground failures across SQL and storage: %s", (message) => {
  expect(iosSqlErrorMessage(new Error(message), "/app/notes.db")).toBe(foregroundMessage);
  expect(mapStorageSdkError(new Error(message), { operation: "storage" })).toBe(foregroundMessage);
  expect(mapStorageSdkError(new Error(message), { operation: "database" })).toBe(foregroundMessage);
});

test.each([
  "database busy - the app is holding a lock on this database; retry shortly: busy_lock",
  `${sdkPrefix}: busy_lock`,
])("maps a locked database to a retryable busy message: %s", (message) => {
  const mapped = iosSqlErrorMessage(new Error(message), "/app/notes.db");
  expect(mapped).toContain("busy_lock");
  expect(mapped).toContain("retry in a moment");
  expect(mapped).not.toContain("Ensure the app embeds");
  expect(mapped).not.toContain("unrecognized error code");
  expect(mapStorageSdkError(new Error(message), { operation: "database" })).toBe(mapped);
});

test("busy_lock is not a key-value storage code", () => {
  expect(mapStorageSdkError(new Error("busy_lock"), { operation: "storage" })).toBeNull();
});

test("capability absence lists foreground and SDK setup as possible causes", () => {
  expect(
    iosSqlErrorMessage(
      new Error("The foreground iOS app does not expose the AutoMobile SDK capability database."),
      "/app/notes.db",
    ),
  ).toBe(capabilityMessage);
});

test.each([
  `${sdkPrefix}: db_inspection_disabled`,
  `${sdkPrefix}: HTTP 503`,
  `${sdkPrefix}: The operation couldn’t be completed. (NSURLErrorDomain error -1004.)`,
  "Failed to connect to CtrlProxy",
])("preserves exact setup advice: %s", (message) => {
  expect(iosSqlErrorMessage(new Error(message), "/app/notes.db")).toBe(
    "Failed to execute SQL on iOS. Ensure the app embeds the AutoMobile SDK in a DEBUG build and calls DatabaseInspector.shared.setEnabled(true).",
  );
});

// Verbatim `SdkDatabaseError.indeterminateMessage` from ios/control-proxy (the runner pins the same text).
const runnerNoAnswerMessage =
  "database request was sent but no answer arrived in time; the outcome is indeterminate (a write may still have been applied). Do not retry automatically; query the data to confirm first";

describe("an unanswered SQL request", () => {
  test("keeps the runner's do-not-retry wording when the host sent a mutation", () => {
    expect(iosSqlErrorMessage(new Error(runnerNoAnswerMessage), "/app/notes.db")).toBe(
      `Failed to execute SQL on iOS: ${runnerNoAnswerMessage}`,
    );
    expect(
      iosSqlErrorMessage(new Error(runnerNoAnswerMessage), "/app/notes.db", {
        readOnlyQuery: false,
      }),
    ).toContain("Do not retry automatically");
  });

  test("words a timed-out read as a plain timeout that is safe to retry", () => {
    const mapped = iosSqlErrorMessage(new Error(runnerNoAnswerMessage), "/app/notes.db", {
      readOnlyQuery: true,
    });
    expect(mapped).toContain("safe to retry");
    expect(mapped).not.toContain("indeterminate");
    expect(mapped).not.toContain("Do not retry");
    expect(mapped).not.toContain("embed the AutoMobile SDK");
  });

  test("a read keeps every other failure's wording", () => {
    const message = "Failed to connect to CtrlProxy";
    expect(iosSqlErrorMessage(new Error(message), "/app/notes.db", { readOnlyQuery: true })).toBe(
      iosSqlErrorMessage(new Error(message), "/app/notes.db"),
    );
  });
});

test("preserves wrong-simulator advice", () => {
  const message =
    "AutoMobile SDK answered from simulator B, but simulator A was requested; the SDK app on this simulator is not reachable. Launch it and retry.";
  expect(iosSqlErrorMessage(new Error(message), "/app/notes.db")).toBe(
    `Failed to execute SQL on iOS: ${message}`,
  );
});

test.each([
  "Other storage requires com.example.app to be the foreground app",
  "Database inspection requires requested appId com.example.app to be the foreground app; unrelated detail",
  "prefix: iOS key-value storage requires com.example.app to be the foreground app",
])("does not infer foreground failure from unrelated text: %s", (message) => {
  expect(mapStorageSdkError(new Error(message), { operation: "storage" })).toBeNull();
  expect(iosSqlErrorMessage(new Error(message), "/app/notes.db")).toBe(
    `Failed to execute SQL on iOS: ${message}`,
  );
});
