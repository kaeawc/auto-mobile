Fixtures for `src/features/iosSimFleet` (#6696).

- `simctl-list-devices.json`: captured from `xcrun simctl list devices -j` (three available
  devices; user name redacted). All captured devices were Shutdown; tests flip `state`.
- `ps-snapshot-two-booted-simulators.txt`: captured `ps -axo pid=,ppid=,rss=,pcpu=,command=` rows
  for host processes (launchd, logd, simdiskimaged, SimLaunchHost) plus two simulator process
  trees. No simulator was booted on the capture host and booting one is not read-only, so the
  `launchd_sim` rows (pids 90001+) follow the documented `launchd_sim <device>/data/var/run/launchd_bootstrap.plist`
  command shape and use synthetic sizes. Re-capture with a booted simulator when one is available.
