import { beforeEach, describe, expect, test } from "bun:test";
import type {
  CtrlProxyIosBuildResult,
  PrefetchBuilder,
} from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { IosCtrlProxyPrefetcher } from "../../src/ctrlProxy/IosCtrlProxyPrefetcher";
import { FakeTimer } from "../fakes/FakeTimer";

class FakePrefetchBuilder implements PrefetchBuilder {
  needsRebuildValue = true;
  buildResult: CtrlProxyIosBuildResult = { success: true, message: "built", buildPath: "/b" };
  buildError: Error | null = null;
  calls: string[] = [];
  gate: Promise<void> | null = null;

  async needsRebuild(): Promise<boolean> {
    this.calls.push("needsRebuild");
    return this.needsRebuildValue;
  }
  async getBuildProductsPath(): Promise<string | null> {
    this.calls.push("getBuildProductsPath");
    return "/products";
  }
  async getXctestrunPath(): Promise<string | null> {
    this.calls.push("getXctestrunPath");
    return "/x.xctestrun";
  }
  async build(): Promise<CtrlProxyIosBuildResult> {
    this.calls.push("build");
    await this.gate;
    if (this.buildError) {
      throw this.buildError;
    }
    return this.buildResult;
  }
}

describe("IosCtrlProxyPrefetcher", () => {
  let builder: FakePrefetchBuilder;
  let timer: FakeTimer;
  let hasPrerequisites: boolean;
  let resolveBuilder: number;

  const make = (platform: NodeJS.Platform = "darwin") =>
    new IosCtrlProxyPrefetcher({
      timer,
      platform,
      prerequisiteDetector: { hasIosPrerequisites: async () => hasPrerequisites },
      builder: () => {
        resolveBuilder++;
        return builder;
      },
    });

  beforeEach(() => {
    builder = new FakePrefetchBuilder();
    timer = new FakeTimer();
    hasPrerequisites = true;
    resolveBuilder = 0;
  });

  test("skips off macOS without touching the builder", async () => {
    const prefetcher = make("linux");
    expect(await prefetcher.prefetch()).toBeNull();
    expect(resolveBuilder).toBe(0);
    expect(prefetcher.pending()).toBeNull();
  });

  test("skips without Xcode prerequisites and records no result", async () => {
    hasPrerequisites = false;
    const prefetcher = make();
    expect(await prefetcher.prefetch()).toBeNull();
    expect(resolveBuilder).toBe(0);
    expect(prefetcher.getResult()).toBeNull();
  });

  test("builds when artifacts are stale and records the successful result", async () => {
    const prefetcher = make();
    const result = await prefetcher.prefetch();
    expect(result).toEqual(builder.buildResult);
    expect(prefetcher.getResult()).toEqual(builder.buildResult);
    expect(builder.calls).toEqual(["needsRebuild", "build"]);
  });

  test("reports up-to-date artifacts without building", async () => {
    builder.needsRebuildValue = false;
    const prefetcher = make();
    const result = await prefetcher.prefetch();
    expect(result).toMatchObject({
      success: true,
      buildPath: "/products",
      xctestrunPath: "/x.xctestrun",
    });
    expect(builder.calls).not.toContain("build");
  });

  test("a failed build result is returned but not recorded as the prefetched result", async () => {
    builder.buildResult = { success: false, message: "nope" };
    const prefetcher = make();
    expect(await prefetcher.prefetch()).toEqual(builder.buildResult);
    expect(prefetcher.getResult()).toBeNull();
    expect(prefetcher.getError()).toBeNull();
  });

  test("a thrown build is recorded as the error and resolves null", async () => {
    builder.buildError = new Error("disk full");
    const prefetcher = make();
    expect(await prefetcher.prefetch()).toBeNull();
    expect(prefetcher.getError()?.message).toBe("disk full");
    expect(await prefetcher.wait()).toBeNull();
  });

  test("is single flight, and pending() is only set while it runs", async () => {
    let release: () => void = () => undefined;
    builder.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prefetcher = make();

    const first = prefetcher.prefetch();
    const second = prefetcher.prefetch();
    expect(second).toBe(first);
    expect(prefetcher.pending()).toBe(first);

    release();
    await first;
    expect(prefetcher.pending()).toBeNull();
    expect(builder.calls.filter((call) => call === "build")).toHaveLength(1);
    expect(await prefetcher.wait()).toEqual(builder.buildResult);
  });

  test("wait() is null before any prefetch, and reset() forgets the outcome", async () => {
    const prefetcher = make();
    expect(await prefetcher.wait()).toBeNull();
    await prefetcher.prefetch();
    prefetcher.reset();
    expect(prefetcher.getResult()).toBeNull();
    expect(await prefetcher.wait()).toBeNull();
    await prefetcher.prefetch();
    expect(builder.calls.filter((call) => call === "build")).toHaveLength(2);
  });
});
