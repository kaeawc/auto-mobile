import { describe, expect, test } from "bun:test";
import type { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ViewHierarchyResult } from "../../../src/models";
import { refreshAndroidViewHierarchy } from "../../../src/features/action/refreshAndroidViewHierarchy";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";

/**
 * Issue #6252: `refreshAndroidViewHierarchy`'s incomplete-hierarchy fallback
 * called `viewHierarchy.getUiAutomatorHierarchy` / `viewHierarchy.mergeHierarchies`,
 * neither of which was ever implemented on `ViewHierarchy` — every fallback
 * attempt threw and was silently swallowed. The function no longer attempts
 * the nonexistent fallback; it must return the (possibly incomplete) hierarchy
 * as-is without throwing.
 */
describe("refreshAndroidViewHierarchy", () => {
  const asClient = (fake: FakeCtrlProxy): AndroidCtrlProxyClient =>
    fake as unknown as AndroidCtrlProxyClient;

  test("returns null when the accessibility service has no hierarchy", async () => {
    const fakeCtrlProxy = new FakeCtrlProxy();
    fakeCtrlProxy.setHierarchyData(null);

    const result = await refreshAndroidViewHierarchy(asClient(fakeCtrlProxy), 1000);

    expect(result).toBeNull();
  });

  test("returns a complete hierarchy unmodified", async () => {
    const fakeCtrlProxy = new FakeCtrlProxy();
    fakeCtrlProxy.setHierarchyData({
      updatedAt: Date.now(),
      packageName: "com.test.app",
      hierarchy: { $: { class: "android.widget.FrameLayout" } },
    });
    const completeResult: ViewHierarchyResult = {
      hierarchy: { node: [] },
      packageName: "com.test.app",
      updatedAt: Date.now(),
      ctrlProxyIncomplete: false,
    };
    fakeCtrlProxy.setViewHierarchyResult(completeResult);

    const result = await refreshAndroidViewHierarchy(asClient(fakeCtrlProxy), 1000);

    expect(result).toEqual(completeResult);
  });

  test("returns an incomplete hierarchy as-is without throwing (no uiautomator fallback exists)", async () => {
    const fakeCtrlProxy = new FakeCtrlProxy();
    fakeCtrlProxy.setHierarchyData({
      updatedAt: Date.now(),
      packageName: "com.test.app",
      hierarchy: { $: {} },
      ctrlProxyIncomplete: true,
    });
    const incompleteResult: ViewHierarchyResult = {
      hierarchy: { node: [] },
      packageName: "com.test.app",
      updatedAt: Date.now(),
      ctrlProxyIncomplete: true,
    };
    fakeCtrlProxy.setViewHierarchyResult(incompleteResult);

    const result = await refreshAndroidViewHierarchy(asClient(fakeCtrlProxy), 1000);

    // Previously this path threw inside a swallowed try/catch (calling two
    // methods that never existed on ViewHierarchy); now it deliberately skips
    // the fallback and returns the incomplete hierarchy straight through.
    expect(result).toEqual(incompleteResult);
  });

  test("forwards the timeoutMs argument positionally to requestHierarchySync", async () => {
    // Issue #6252's old signature was
    // `refreshAndroidViewHierarchy(accessibilityService, viewHierarchy, timeoutMs, signal)`.
    // Calling the *new* two-arg signature `(accessibilityService, timeoutMs)`
    // against the *old* implementation silently mis-binds positionally: the
    // literal `1000` below lands in the old `viewHierarchy` parameter and the
    // old `timeoutMs` parameter is left `undefined` — so `undefined`, not
    // `1000`, would reach `requestHierarchySync`. The two return-value-only
    // tests above can't see this: FakeCtrlProxy.requestHierarchySync ignores
    // its arguments and returns the same configured hierarchy regardless of
    // what (or whether) `timeoutMs` was passed, and the old code's dead
    // uiautomator-fallback throw is silently swallowed either way, so both
    // implementations produce an identical return value. Only inspecting what
    // was actually passed to requestHierarchySync tells old and new apart.
    const fakeCtrlProxy = new FakeCtrlProxy();
    fakeCtrlProxy.setHierarchyData({
      updatedAt: Date.now(),
      packageName: "com.test.app",
      hierarchy: { $: {} },
    });

    await refreshAndroidViewHierarchy(asClient(fakeCtrlProxy), 1000);

    expect(fakeCtrlProxy.getLastRequestHierarchySyncArgs()?.timeoutMs).toBe(1000);
  });
});
