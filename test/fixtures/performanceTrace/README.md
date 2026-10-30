# performanceTrace fixtures

- `xctrace-toc.xml`, `xctrace-time-profile.xml`, `xctrace-hitches.xml`,
  `xctrace-potential-hangs.xml`, `xctrace-life-cycle-period.xml`: the original synthetic
  shapes from #14353.
- `xctrace-*-macos-host.xml` (#15330): captured 2026-10-25 from a real macOS-host
  `xcrun xctrace record --template "Time Profiler" --time-limit 2s --launch -- sleep 3`
  (xctrace 16.0 (17F113), Xcode 26.6), then `xctrace export --toc` and
  `--xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'`. Host name and
  UUID are scrubbed. The real table cells differ from the synthetic ones (the backtrace is a
  `tagged-backtrace` cell), so parsers are tested against these.
- `xctrace-time-profile-xcode27-sim.xml`: captured `time-profile` table export from
  Xcode 27.1 beta (xctrace 27.1, build 27A9269) on a booted iPhone 18 Pro iOS 27.0
  simulator, truncated to the first 200 rows with all refs resolving; home path scrubbed to
  `/Users/user/`. Frames sit directly under `tagged-backtrace` without an inner `backtrace`.
- `xctrace-toc-empty-unfinalized-hitches-ios27.xml` (#15330): `xctrace export --toc` of the
  556K `hitches` trace the 0.0.88 smoke run stopped on an iOS 27.0 simulator (the stop returned
  success): zero duration, no processes, empty `<data/>`. Host name and UUID are scrubbed.
- `xctrace-export-*.stderr.txt` (#15330): the stderr of `xctrace export --toc` for a trace
  xctrace never finalized (`Trace is malformed - run data is missing.`, killed after SIGINT)
  and for a trace with no template document (`Document Missing Template Error`, the 52K traces).
