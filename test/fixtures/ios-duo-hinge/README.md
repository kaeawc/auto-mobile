# iPhone Duo hinge vs layout captures

Captured on one iPhone Duo simulator (iOS 27.1, Xcode 27.1 beta) for #17702 / #17726. Host
paths are replaced; the content is otherwise verbatim.

- `setposture-120-after-80-stuck.json`: `setPosture {hingeAngle: 120}` after `0 -> 80`. The app
  stayed on the cover layout (386x678) with `UIHinge.status = closed` at 118.3 degrees, while
  the result echoed `observedHingeAngle: 120` and reported `posture: unknown`.
- `getdevicestate-stuck.json`: `getDeviceState` in that state (cover panel active, `closed`).
- `setposture-90-from-0.json`: `setPosture {hingeAngle: 90}` from 0 (cover layout, as expected).
- `app-hinge-sweep-1.txt`, `app-hinge-sweep-2.txt`: a probe app's `UIHingeInteraction` readings
  per requested angle. `status` is `UIHinge.Status` (1 closed, 2 partiallyOpen, 3 fullyOpen),
  `angleDeg` the app-visible angle and `view` the app window in points. Each line is a
  consistent hinge/layout pair; the panel switch is path dependent, so 82-90 degrees can show
  either panel.
