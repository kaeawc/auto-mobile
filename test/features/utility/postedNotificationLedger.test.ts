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

  test("leaves content two apps posted attributed to neither", () => {
    const ledger = new InMemoryPostedNotificationLedger();
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    ledger.record("sim-a", "com.y", { title: "same", body: "text" });
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    expect(ledger.postedBy("sim-a", "com.x")).toEqual([]);
    expect(ledger.postedBy("sim-a", "com.y")).toEqual([]);
  });

  test("keeps content one app posted twice attributed to it", () => {
    const ledger = new InMemoryPostedNotificationLedger();
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    expect(ledger.postedBy("sim-a", "com.x")).toEqual([{ title: "same", body: "text" }]);
  });

  test("still sees a collision after many other posts", () => {
    const ledger = new InMemoryPostedNotificationLedger();
    ledger.record("sim-a", "com.x", { title: "same", body: "text" });
    for (let index = 0; index < 150; index++) {
      ledger.record("sim-a", "com.z", { title: `filler ${index}`, body: "" });
    }
    ledger.record("sim-a", "com.y", { title: "same", body: "text" });
    expect(ledger.postedBy("sim-a", "com.y")).toEqual([]);
    expect(ledger.postedBy("sim-a", "com.x")).toEqual([]);
  });
});
