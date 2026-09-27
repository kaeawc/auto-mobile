import { describe, expect, test } from "bun:test";
import { DefaultSimulatorAppPresenter } from "../../../src/utils/ios-cmdline-tools/SimulatorAppPresenter";

describe("SimulatorAppPresenter", () => {
  test("concurrent attempts for the same boot share one open", async () => {
    let opens = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const presenter = new DefaultSimulatorAppPresenter(async () => {
      opens++;
      await pending;
      return true;
    });
    const first = presenter.presentAfterStart("device", "boot-1");
    const second = presenter.presentAfterStart("device", "boot-1");
    await Promise.resolve();
    expect(opens).toBe(1);
    finish();
    await Promise.all([first, second]);
    await presenter.presentAfterStart("device", "boot-1");
    expect(opens).toBe(1);
  });

  test("a later genuine boot presents again", async () => {
    let opens = 0;
    const presenter = new DefaultSimulatorAppPresenter(async () => {
      opens++;
      return true;
    });
    await presenter.presentAfterStart("device", "boot-1");
    await presenter.presentAfterStart("device", "boot-2");
    expect(opens).toBe(2);
  });

  test("retains only the latest generation for a simulator", async () => {
    let opens = 0;
    const presenter = new DefaultSimulatorAppPresenter(async () => {
      opens++;
      return true;
    });
    for (let generation = 0; generation < 20; generation++) {
      await presenter.presentAfterStart("device", `boot-${generation}`);
    }
    expect(opens).toBe(20);
    expect(presenter.trackedPresentationCountForTests()).toBe(1);
  });

  test("presentation failure does not fail a start or retry the same boot", async () => {
    let opens = 0;
    const presenter = new DefaultSimulatorAppPresenter(async () => {
      opens++;
      throw new Error("GUI unavailable");
    });
    await expect(presenter.presentAfterStart("device", "boot-1")).resolves.toBeUndefined();
    await presenter.presentAfterStart("device", "boot-1");
    expect(opens).toBe(1);
  });
});
