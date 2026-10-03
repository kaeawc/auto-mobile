import { expect, spyOn, test } from "bun:test";
import {
  BoundedScreenshotPathProtection,
  screenshotPathProtection,
} from "../../src/features/observe/ScreenshotPathProtection";
import { FakeFileSystem } from "../fakes/FakeFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import {
  getObserveCacheStore,
  setObserveCacheStore,
} from "../../src/features/observe/cache/ObserveCacheRegistry";

test("unit default sweeps cannot leave filesystem work queued for another file", async () => {
  const files = new FakeFileSystem();
  const read = spyOn(files, "readdir");
  try {
    await screenshotPathProtection.sweep("/unit-default-screenshots", files);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

test("explicit retention instances still inventory their injected filesystem", async () => {
  const files = new FakeFileSystem();
  const read = spyOn(files, "readdir");
  const timer = new FakeTimer();
  const previousCache = getObserveCacheStore();
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  try {
    const protection = new BoundedScreenshotPathProtection(timer);
    await protection.sweep("/unit-explicit-screenshots", files);
    expect(read).toHaveBeenCalledWith("/unit-explicit-screenshots");
  } finally {
    read.mockRestore();
    setObserveCacheStore(previousCache);
  }
});
