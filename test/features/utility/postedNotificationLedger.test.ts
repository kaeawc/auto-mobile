import { describe, expect, test } from "bun:test";
import { InMemoryPostedNotificationLedger } from "../../../src/features/utility/postedNotificationLedger";

describe("InMemoryPostedNotificationLedger", () => {
  test("lists an app's posts on one device, newest first", () => {
    const ledger = new InMemoryPostedNotificationLedger();
    ledger.record("sim-a", "com.x", { title: "one", body: "1" });
    ledger.record("sim-a", "com.y", { title: "other", body: "o" });
    ledger.record("sim-a", "com.x", { title: "two", body: "2" });
    ledger.record("sim-b", "com.x", { title: "elsewhere", body: "e" });
    expect(ledger.postedBy("sim-a", "com.x")).toEqual([
      { title: "two", body: "2" },
      { title: "one", body: "1" },
    ]);
  });

  test("gives identical content to the app that posted it last", () => {
    const ledger = new InMemoryPostedNotificationLedger();
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    ledger.record("sim-a", "com.y", { title: "same", body: "text" });
    expect(ledger.postedBy("sim-a", "com.x")).toEqual([]);
    expect(ledger.postedBy("sim-a", "com.y")).toEqual([{ title: "same", body: "text" }]);
  });

  test("keeps only the newest records per device", () => {
    const ledger = new InMemoryPostedNotificationLedger(2);
    ["a", "b", "c"].forEach((title) => ledger.record("sim-a", "com.x", { title, body: "" }));
    expect(ledger.postedBy("sim-a", "com.x").map(({ title }) => title)).toEqual(["c", "b"]);
  });
});
