import { describe, expect, test } from "bun:test";
import {
  SHARED_STORAGE_RESOURCE_TEMPLATES,
  buildSharedStorageResourceUri,
  parseSharedStorageResourceParams,
} from "../../src/server/sharedStorageResourceContract";

describe("shared-storage resource contract", () => {
  test("exposes namespace-list and file-read templates", () => {
    expect(SHARED_STORAGE_RESOURCE_TEMPLATES.NAMESPACE).toBe(
      "automobile:devices/{deviceId}/downloads/{namespace}",
    );
    expect(SHARED_STORAGE_RESOURCE_TEMPLATES.FILE).toBe(
      "automobile:devices/{deviceId}/downloads/{namespace}/{path}",
    );
  });

  test("round-trips a namespace URI with encoded segments", () => {
    const uri = buildSharedStorageResourceUri({ deviceId: "emulator-5554", namespace: "run 42" });
    expect(uri).toBe("automobile:devices/emulator-5554/downloads/run%2042");
    expect(
      parseSharedStorageResourceParams({ deviceId: "emulator-5554", namespace: "run%2042" }),
    ).toEqual({
      deviceId: "emulator-5554",
      namespace: "run 42",
    });
  });

  test("round-trips a nested file URI, encoding each path segment", () => {
    const uri = buildSharedStorageResourceUri({
      deviceId: "emulator-5554",
      namespace: "run-42",
      path: "docs/read me.txt",
    });
    expect(uri).toBe("automobile:devices/emulator-5554/downloads/run-42/docs/read%20me.txt");
    expect(
      parseSharedStorageResourceParams({
        deviceId: "emulator-5554",
        namespace: "run-42",
        path: "docs/read%20me.txt",
      }),
    ).toEqual({
      deviceId: "emulator-5554",
      namespace: "run-42",
      path: "docs/read me.txt",
    });
  });

  test("rejects a namespace that is not a single Downloads child", () => {
    for (const namespace of ["", ".", "..", "a%2Fb", "a%5Cb"]) {
      expect(() =>
        parseSharedStorageResourceParams({ deviceId: "emulator-5554", namespace }),
      ).toThrow();
    }
  });

  test("rejects file paths that traverse or escape the namespace", () => {
    for (const path of ["../outside.txt", "%2e%2e/outside.txt", "/etc/hosts", "docs/../../x"]) {
      expect(() =>
        parseSharedStorageResourceParams({ deviceId: "emulator-5554", namespace: "run-42", path }),
      ).toThrow();
    }
  });
});
