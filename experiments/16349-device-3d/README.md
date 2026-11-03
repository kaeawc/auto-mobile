# 3D device view prototype (#16349) — throwaway, not for merge

CSS-3D add-on for the static prototype web page: a 3D toggle, a posture select using the
`setPosture` names, a 0–360° hinge slider, arrow-key / Shift-drag orbit, and a 2D↔3D transition
that never re-renders the shown view.

- `devicePose.ts` — pure pose rules (orbit, hinge → CSS transforms; hinge → panel layout).
- `device3dRuntime.ts` — the self-contained page script and its CSS.
- `build.ts` — builds the reference-checkout page, injects the script (adding its CSP hash),
  measures the bytes it adds, and screenshots eight poses in headless Chromium.
- `entry.ts` — bundler entry used only for the minified-size measurement.

```bash
bun experiments/16349-device-3d/build.ts            # writes scratch/16349-device-3d/
```

The design note is `docs/design-docs/prototype-web-3d.md` on the `work/16349-auto` branch.
