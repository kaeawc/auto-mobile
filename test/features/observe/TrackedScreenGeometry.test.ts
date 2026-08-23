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
    geometry.markForwarded(7);
    expect(geometry.isForwarded).toBe(true);
  });

  it("drops provenance when the geometry changes", () => {
    // The resolution-change case: new dimensions have not been seen by the daemon yet, so a
    // screenshot declaring them must not be paired with the previous capture.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded(7);

    geometry.update(720, 1560);
    expect(geometry.width).toBe(720);
    expect(geometry.isForwarded).toBe(false);

    geometry.markForwarded(7);
    expect(geometry.isForwarded).toBe(true);
  });

  it("keeps provenance when the same geometry is re-derived", () => {
    // The common case: every hierarchy re-derives the same dimensions, and re-deriving them must
    // not flap the claim off and strand control in a permanent fail-closed state.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded(7);
    geometry.update(1080, 2340);
    expect(geometry.isForwarded).toBe(true);
  });

  it("cannot manufacture provenance for geometry that does not exist", () => {
    // A push with nothing cached must not leave a vouch behind that a later fallback-derived
    // dimension could inherit.
    const geometry = new TrackedScreenGeometry();
    geometry.markForwarded(7);
    expect(geometry.isForwarded).toBe(false);
    expect(geometry.bind()).toBeNull();
  });

  it("clears tracked state for unusable geometry instead of keeping the previous entry", () => {
    // Keeping forwarded dimensions across a hierarchy that cannot confirm them would let a later
    // push vouch for geometry that no longer describes the device.
    for (const [width, height] of [
      [0, 0],
      [-1, 100],
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
    ]) {
      const geometry = new TrackedScreenGeometry();
      geometry.update(1080, 2340);
      geometry.markForwarded(7);

      geometry.update(width, height);
      expect(geometry.width).toBeNull();
      expect(geometry.isForwarded).toBe(false);
      expect(geometry.bind()).toBeNull();
    }
  });

  it("binds the identity and dimensions that are current at request initiation", () => {
    // The binding is what survives same-resolution navigation: a frame requested under capture 7
    // must stay labelled 7 even after capture 8 is forwarded at identical dimensions.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded(7);

    const binding = geometry.bind();
    expect(binding).toEqual({ captureSequence: 7, width: 1080, height: 2340 });

    geometry.markForwarded(8);
    expect(binding).toEqual({ captureSequence: 7, width: 1080, height: 2340 });
    expect(geometry.bind()?.captureSequence).toBe(8);
  });

  it("drops both geometry and provenance when cleared", () => {
    const geometry = new TrackedScreenGeometry();
    geometry.update(1080, 2340);
    geometry.markForwarded(7);
    geometry.clear();
    expect(geometry.width).toBeNull();
    expect(geometry.isForwarded).toBe(false);
  });

  it("carries the coordinate space bound at update time through markForwarded and bind (#4549)", () => {
    const geometry = new TrackedScreenGeometry();
    geometry.update(1170, 2532, "px");
    geometry.markForwarded(9);
    expect(geometry.bind()).toEqual({
      captureSequence: 9,
      width: 1170,
      height: 2532,
      coordinateSpace: "px",
    });
  });

  it("omits coordinateSpace from the binding when the geometry was bound in legacy point-space", () => {
    const geometry = new TrackedScreenGeometry();
    geometry.update(1170, 2532); // no space => legacy
    geometry.markForwarded(9);
    expect(geometry.bind()).toEqual({ captureSequence: 9, width: 1170, height: 2532 });
  });

  it("resets provenance on a coordinate-space flip even when the numeric dimensions coincide", () => {
    // On a non-Display-Zoom device points*screenScale == points*nativeScale, so metadata
    // appearing (legacy -> px) does not move the pixels. The space change must still reset the
    // forwarded flag, or a later push would vouch a px identity for a legacy-bound capture.
    const geometry = new TrackedScreenGeometry();
    geometry.update(1170, 2532); // legacy
    geometry.markForwarded(9);
    expect(geometry.isForwarded).toBe(true);

    geometry.update(1170, 2532, "px"); // same dims, space flips
    expect(geometry.isForwarded).toBe(false);
    expect(geometry.bind()).toBeNull();
  });
});
