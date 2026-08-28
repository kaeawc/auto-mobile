# Performance

Ask AutoMobile to measure a flow and report slow or janky steps. It can
compare startup, screen transitions, and scrolling behavior across repeated
runs.

Example prompts:

> Launch my Android app five times, measure cold and warm startup, and report
> time to first frame, time to interactive, and outliers.

> Open the product list, scroll it five times at the same speed, and report FPS,
> missed frames, visible jank, and the worst session.

Use the same device, content, and flow when comparing builds. Emulators and
simulators are useful for repeatable comparisons; confirm important results on
physical devices.

The AutoMobile Desktop App presents collected performance statistics as charts
for reviewing runs and spotting regressions.
