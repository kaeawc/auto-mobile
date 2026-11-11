import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { watchNotificationDeliveryVerdict } from "../../../src/features/utility/ios/watchNotificationDeliveryLog";

const bundleId = "dev.dogfood.factorywatch";
const capture = readFileSync(
  new URL("../../fixtures/ios/watch-log-saving-notification.txt", import.meta.url),
  "utf8",
);
const lines = capture.split("\n").filter((line) => line.includes("Saving notification"));
const noLines = lines.filter((line) => line.includes(": NO ["));
const yesLines = lines.filter((line) => line.includes(": YES ["));

describe("watch notification delivery verdict", () => {
  test("reads NO from the unauthorized capture", () => {
    expect(watchNotificationDeliveryVerdict(noLines.join("\n"), bundleId)).toBe("NO");
  });
  test("reads YES from the authorized capture", () => {
    expect(watchNotificationDeliveryVerdict(yesLines.join("\n"), bundleId)).toBe("YES");
  });
  test("takes the newest verdict in the full chronological capture", () => {
    expect(watchNotificationDeliveryVerdict(capture, bundleId)).toBe("YES");
  });
  test("uses the last matching line even after a YES", () => {
    expect(watchNotificationDeliveryVerdict([...yesLines, ...noLines].join("\n"), bundleId)).toBe(
      "NO",
    );
  });
  test("ignores other bundles, including a prefix of the target bundle", () => {
    expect(watchNotificationDeliveryVerdict(capture, "dev.dogfood.factory")).toBeNull();
    expect(watchNotificationDeliveryVerdict(capture, "com.example.other")).toBeNull();
    const otherBundle = yesLines.map((line) =>
      line.replace(`[${bundleId}]`, "[com.example.other]"),
    );
    expect(
      watchNotificationDeliveryVerdict([...noLines, ...otherBundle].join("\n"), bundleId),
    ).toBe("NO");
  });
  test("ignores the log tool's own self-lines", () => {
    // Derive a self-line from a whole captured line, changing only the log source marker.
    const selfLines = yesLines.map((line) =>
      line.replace("[com.apple.UserNotifications:DataStore]", "[com.apple.log:]"),
    );
    expect(watchNotificationDeliveryVerdict([...noLines, ...selfLines].join("\n"), bundleId)).toBe(
      "NO",
    );
  });
  test("returns null without delivery lines", () => {
    expect(watchNotificationDeliveryVerdict("", bundleId)).toBeNull();
    expect(watchNotificationDeliveryVerdict(capture.split("\n")[0], bundleId)).toBeNull();
  });
});
