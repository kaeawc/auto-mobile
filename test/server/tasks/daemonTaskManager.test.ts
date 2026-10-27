import { describe, expect, test } from "bun:test";
import {
  daemonTaskLeaseKeepalive,
  releaseDaemonTaskLeases,
} from "../../../src/daemon/tasks/daemonTaskManager";

describe("daemonTaskLeaseKeepalive (#13143)", () => {
  test("a daemon started after a shutdown in the same process gets a keeper that still holds", () => {
    const first = daemonTaskLeaseKeepalive();
    expect(daemonTaskLeaseKeepalive()).toBe(first);

    releaseDaemonTaskLeases();

    const next = daemonTaskLeaseKeepalive();
    expect(next).not.toBe(first);
    expect(next.closed).toBe(false);
    expect(first.closed).toBe(true);
  });
});
