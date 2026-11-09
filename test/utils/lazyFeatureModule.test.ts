import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { lazyFeatureModule, type LazyFeatureLog } from "../../src/utils/lazyFeatureModule";
import { FakeTimer } from "../fakes/FakeTimer";

class RecordingLog implements LazyFeatureLog {
  readonly infos: string[] = [];
  readonly warns: string[] = [];
  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warns.push(message);
  }
}

describe("lazyFeatureModule", () => {
  test("imports nothing until the first load, then memoizes the module", async () => {
    let imports = 0;
    const module = { name: "feature" };
    const lazy = lazyFeatureModule(
      "demo",
      async () => {
        imports++;
        return module;
      },
      { log: new RecordingLog() },
    );
    expect(imports).toBe(0);
    expect(lazy.loaded()).toBeUndefined();
    const [first, second] = await Promise.all([lazy.load(), lazy.load()]);
    expect(first).toBe(module);
    expect(second).toBe(module);
    expect(await lazy.load()).toBe(module);
    expect(lazy.loaded()).toBe(module);
    expect(imports).toBe(1);
  });

  test("logs the first load's latency once", async () => {
    const timer = new FakeTimer();
    const log = new RecordingLog();
    const lazy = lazyFeatureModule(
      "demo",
      async () => {
        timer.setCurrentTime(timer.now() + 42);
        return {};
      },
      { clock: timer, log },
    );
    await lazy.load();
    await lazy.load();
    expect(log.infos).toEqual(["[lazy-feature] demo module loaded in 42 ms"]);
  });

  test("a failed import is reported, not memoized, and retried on the next load", async () => {
    const log = new RecordingLog();
    let attempts = 0;
    const lazy = lazyFeatureModule(
      "demo",
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("chunk missing");
        }
        return { ok: true };
      },
      { log },
    );
    const failure = await lazy.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as Error).message).toBe("Failed to load the demo module: chunk missing");
    expect(log.warns).toEqual(["[lazy-feature] demo module failed to load"]);
    expect(lazy.loaded()).toBeUndefined();
    expect(await lazy.load()).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });
});
