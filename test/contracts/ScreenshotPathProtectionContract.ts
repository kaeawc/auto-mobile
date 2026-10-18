import { describe, expect, test } from "bun:test";
import {
  SCREENSHOT_PATH_MIN_LIFETIME_MS,
  type ScreenshotPathProtection,
} from "../../src/features/observe/ScreenshotRetention";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeFileSystem } from "../fakes/FakeFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Shared behavioural contract for {@link ScreenshotPathProtection} (#11868): the fake and
 * BoundedScreenshotPathProtection run the same lease, removal-fencing and write-ordering
 * scenarios on the same FakeTimer and an in-memory directory. Capacity eviction and the
 * inventory sweep are real-only behaviour and stay covered by the ScreenshotRetention tests.
 */
export function runScreenshotPathProtectionContract(
  name: string,
  make: (timer: FakeTimer, fileSystem: FakeFileSystem) => ScreenshotPathProtection,
): void {
  const DIRECTORY = "/shots";
  const PATH = `${DIRECTORY}/screenshot_a.png`;

  const withProtection = async (
    body: (
      protection: ScreenshotPathProtection,
      timer: FakeTimer,
      fileSystem: FakeFileSystem,
    ) => Promise<void> | void,
  ): Promise<void> => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const fileSystem = new FakeFileSystem();
    fileSystem.setDirectory(DIRECTORY);
    await body(make(timer, fileSystem), timer, fileSystem);
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  // Lets every already-queued promise continuation run without involving a timer.
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  describe(`ScreenshotPathProtection contract: ${name}`, () => {
    test("protect leases a path for the minimum lifetime and returns the deadline", () =>
      withProtection(async (protection, timer) => {
        expect(protection.isProtected(PATH)).toBe(false);
        const deadline = await protection.protect(PATH);
        expect(deadline).toBe(timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS);
        expect(protection.isProtected(PATH)).toBe(true);
        expect(protection.isProtected(`${DIRECTORY}/screenshot_b.png`)).toBe(false);
      }));

    test("the lease ends exactly at its deadline", () =>
      withProtection(async (protection, timer) => {
        await protection.protect(PATH);
        timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
        expect(protection.isProtected(PATH)).toBe(true);
        timer.advanceTime(1);
        expect(protection.isProtected(PATH)).toBe(false);
      }));

    test("protecting again extends the lease from the new time", () =>
      withProtection(async (protection, timer) => {
        await protection.protect(PATH);
        timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS / 2);
        const deadline = await protection.protect(PATH);
        expect(deadline).toBe(timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS);
        timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
        expect(protection.isProtected(PATH)).toBe(true);
      }));

    test("removeIfUnprotected leaves a protected path alone", () =>
      withProtection(async (protection) => {
        await protection.protect(PATH);
        let removals = 0;
        const removed = await protection.removeIfUnprotected(PATH, async () => {
          removals += 1;
          return true;
        });
        expect(removed).toBe(false);
        expect(removals).toBe(0);
      }));

    test("removeIfUnprotected runs the removal for an unprotected path and reports its result", () =>
      withProtection(async (protection, timer) => {
        expect(await protection.removeIfUnprotected(PATH, async () => true)).toBe(true);
        expect(await protection.removeIfUnprotected(PATH, async () => false)).toBe(false);
        await protection.protect(PATH);
        timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
        expect(await protection.removeIfUnprotected(PATH, async () => true)).toBe(true);
      }));

    test("a second removal of the same path is refused while the first is in flight", () =>
      withProtection(async (protection) => {
        const gate = deferred();
        let second = 0;
        const first = protection.removeIfUnprotected(PATH, async () => {
          await gate.promise;
          return true;
        });
        await tick();
        const refused = await protection.removeIfUnprotected(PATH, async () => {
          second += 1;
          return true;
        });
        gate.resolve();
        expect(await first).toBe(true);
        expect(refused).toBe(false);
        expect(second).toBe(0);
      }));

    test("protect waits for an in-flight removal instead of leasing a ghost", () =>
      withProtection(async (protection) => {
        const gate = deferred();
        const removal = protection.removeIfUnprotected(PATH, async () => {
          await gate.promise;
          return true;
        });
        await tick();
        let protectedDone = false;
        const leasing = protection.protect(PATH).then((deadline) => {
          protectedDone = true;
          return deadline;
        });
        await tick();
        expect(protectedDone).toBe(false);
        gate.resolve();
        await removal;
        await leasing;
        expect(protectedDone).toBe(true);
        expect(protection.isProtected(PATH)).toBe(true);
      }));

    test("write runs the operation", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        let writes = 0;
        await protection.write(PATH, {
          size: 10,
          write: async () => {
            writes += 1;
          },
          remove: async () => {},
          fileSystem,
        });
        expect(writes).toBe(1);
      }));

    test("a path being written cannot be removed until the write commits", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        const gate = deferred();
        const writing = protection.write(PATH, {
          size: 10,
          write: () => gate.promise,
          remove: async () => {},
          fileSystem,
        });
        await tick();
        let removals = 0;
        const refused = await protection.removeIfUnprotected(PATH, async () => {
          removals += 1;
          return true;
        });
        gate.resolve();
        await writing;
        expect(refused).toBe(false);
        expect(removals).toBe(0);
      }));

    test("writes into one directory run one at a time, in order", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        const order: string[] = [];
        const gate = deferred();
        // The real implementation reads its inventory through async stores before the write
        // starts; await the write's own start signal instead of polling for it.
        const firstStarted = deferred();
        const first = protection.write(PATH, {
          size: 10,
          write: async () => {
            order.push("first:start");
            firstStarted.resolve();
            await gate.promise;
            order.push("first:end");
          },
          remove: async () => {},
          fileSystem,
        });
        const second = protection.write(`${DIRECTORY}/screenshot_b.png`, {
          size: 10,
          write: async () => {
            order.push("second:start");
          },
          remove: async () => {},
          fileSystem,
        });
        await firstStarted.promise;
        await tick();
        expect(order).toEqual(["first:start"]);
        gate.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(["first:start", "first:end", "second:start"]);
      }));

    test("a failed write surfaces as an ActionableError that names the cause", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        const failure = protection.write(PATH, {
          size: 10,
          write: async () => {
            throw new Error("disk full");
          },
          remove: async () => {},
          fileSystem,
        });
        await expect(failure).rejects.toBeInstanceOf(ActionableError);
        await expect(failure).rejects.toThrow("Failed to write retained screenshot");
        await expect(failure).rejects.toThrow("disk full");
      }));

    test("a failed write does not block later writes or leave the path unremovable", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        await protection
          .write(PATH, {
            size: 10,
            write: async () => {
              throw new Error("disk full");
            },
            remove: async () => {},
            fileSystem,
          })
          .catch(() => undefined);
        let writes = 0;
        await protection.write(PATH, {
          size: 10,
          write: async () => {
            writes += 1;
          },
          remove: async () => {},
          fileSystem,
        });
        expect(writes).toBe(1);
        expect(await protection.removeIfUnprotected(PATH, async () => true)).toBe(true);
      }));

    test("sweep and sweepOnce are best-effort and never reject", () =>
      withProtection(async (protection, _timer, fileSystem) => {
        await protection.sweep(DIRECTORY, fileSystem);
        await protection.sweepOnce(DIRECTORY, fileSystem);
        await protection.sweepOnce(DIRECTORY, fileSystem);
        await protection.sweep("/missing-directory", fileSystem);
        await protection.sweepOnce("/missing-directory", fileSystem);
      }));
  });
}
