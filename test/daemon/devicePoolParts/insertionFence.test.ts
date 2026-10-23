import { expect, test } from "bun:test";
import { insertionWasFenced } from "../../../src/daemon/devicePoolParts/insertionFence";

test.each(["none", "removed", "reserved", "unpooled", "shutdown", "changed", "captured"] as const)(
  "insertion fence covers %s",
  (reason) => {
    const intentionalShutdowns = new Map<string, number>();
    if (reason === "changed") {
      intentionalShutdowns.set("device", 2);
    }
    if (reason === "captured") {
      intentionalShutdowns.set("device", 1);
    }
    expect(
      insertionWasFenced(
        {
          intentionalShutdowns,
          isDeviceUnderShutdown: () => reason === "shutdown",
          isUnpooledShutdownFenced: () => reason === "unpooled",
        },
        "device",
        { wasRemoved: () => reason === "removed" },
        {
          shutdownMarker: reason === "captured" ? 1 : undefined,
          shutdownReserved: reason === "reserved",
        },
      ),
    ).toBe(reason !== "none");
  },
);

test("a marker present at discovery start fences even after it is cleared", () => {
  expect(
    insertionWasFenced(
      {
        intentionalShutdowns: new Map(),
        isDeviceUnderShutdown: () => false,
        isUnpooledShutdownFenced: () => false,
      },
      "device",
      { wasRemoved: () => false },
      { shutdownMarker: 1, shutdownReserved: false },
    ),
  ).toBe(true);
});
