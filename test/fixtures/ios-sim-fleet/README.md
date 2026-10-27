Fixtures for `src/features/iosSimFleet` (#6696).

- The `simctl list devices -j` capture is shared with the reconcile tests: `../ios-simctl/list-devices.json`
  (all captured devices were Shutdown; tests flip `state`).
- `ps-snapshot-two-booted-simulators.txt`: captured `ps -axo pid=,ppid=,rss=,pcpu=,command=` rows
  for host processes (launchd, logd, simdiskimaged, SimLaunchHost) plus two simulator process
  trees. No simulator was booted on the capture host and booting one is not read-only, so the
  `launchd_sim` rows (pids 90001+) follow the documented `launchd_sim <device>/data/var/run/launchd_bootstrap.plist`
  command shape and use synthetic sizes. Re-capture with a booted simulator when one is available.
- `ps-captured-one-booted-simulator.txt` / `top-captured-one-booted-simulator.txt` (#15288): a real
  booted simulator tree (266 processes under one `launchd_sim`) plus `launchd`, captured back to back as
  `ps -axo pid=,ppid=,rss=,pcpu=,command=` and `top -l 1 -stats pid,mem` (the first ten lines are
  `top`'s summary header, kept so the parser is tested against the real shape). The tree sums to
  about 24.6 GiB of RSS but 3.8 GiB of footprint (this is the busier foreign CI simulator with 266
  processes; idle AutoMobile simulators measured 2.1–2.4 GiB, #15288); `top`'s `MEM` matched `footprint -p` on the
  processes spot-checked.
