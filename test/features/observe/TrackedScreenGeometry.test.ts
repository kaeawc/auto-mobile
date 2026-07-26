import { describe, expect, it } from "bun:test";
import { TrackedScreenGeometry } from "../../../src/features/observe/TrackedScreenGeometry";

/**
 * The capture-provenance rule both CtrlProxy clients share (issue #3348): a screenshot may only
 * claim its geometry is capture-tracked once the daemon has actually been sent a hierarchy carrying
 * that geometry. When in doubt the claim must be false — the daemon then omits the capture identity
 * and a control client fails closed, which is safe; a wrong identity is not.
 */
describe("TrackedScreenGeometry", () => {
  it("starts with no geometry and no provenance", () => {
    const geometry = new TrackedScreenGeometry();
    expect(geometry.width).toBeNull();
    expect(geometry.height).toBeNull();
    expect(geometry.isForwarded).toBe(false);
  });

  it("does not claim provenance for geometry that was never forwarded", () => {
    // The suppressed-hierarchy case: the cache is updated from a hierarchy the daemon never sees.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    expect(geometry.width).toBe(1080);
    expect(geometry.isForwarded).toBe(false);
  });

  it("claims provenance once the hierarchy carrying the geometry is forwarded", () => {
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded();
    expect(geometry.isForwarded).toBe(true);
  });

  it("drops provenance when the geometry changes", () => {
    // The resolution-change case: new dimensions have not been seen by the daemon yet, so a
    // screenshot declaring them must not be paired with the previous capture.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded();

    geometry.update(720, 1560);
    expect(geometry.width).toBe(720);
    expect(geometry.isForwarded).toBe(false);

    geometry.markForwarded();
    expect(geometry.isForwarded).toBe(true);
  });

  it("keeps provenance when the same geometry is re-derived", () => {
    // The common case: every hierarchy re-derives the same dimensions, and re-deriving them must
    // not flap the claim off and strand control in a permanent fail-closed state.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded();
    geometry.update(1080, 2340);
    expect(geometry.isForwarded).toBe(true);
  });

  it("cannot manufacture provenance for geometry that does not exist", () => {
    // A push with nothing cached (or a non-positive size) must not leave a vouch behind that a
    // later fallback-derived dimension could inherit.
    const geometry = new TrackedScreenGeometry();
    geometry.markForwarded();
    expect(geometry.isForwarded).toBe(false);

    geometry.update(0, 0);
    expect(geometry.width).toBeNull();
    expect(geometry.isForwarded).toBe(false);
  });

  it("drops both geometry and provenance when cleared", () => {
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded();
    geometry.clear();
    expect(geometry.width).toBeNull();
    expect(geometry.isForwarded).toBe(false);
  });
});
