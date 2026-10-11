Fixtures for `src/features/bootAdmission` (#11588).

- `ps-snapshot-one-running-emulator.txt`: rows of one `ps -axo pid=,ppid=,rss=,pcpu=,command=`
  capture (macOS 26, Android Emulator 37.1.11, 2026-10-10) taken while an AutoMobile daemon ran one
  headless emulator it had booted. Kept rows: `launchd`, `logd`, `syslogd`, a Chrome crashpad
  helper (a path with spaces and ` --` arguments), the daemon (pid 61847), its emulator's
  `qemu-system-aarch64-headless` process (pid 67978, whose parent IS the daemon: the `emulator`
  launcher the daemon spawned became the qemu process), and the emulator's `crashpad_handler` and
  `netsimd` helpers. Every other row of the capture was dropped. No row is synthetic. Redactions
  only: the user name in `/Users/<name>` and `/tmp/android-<name>` is `dev`, and the daemon's
  checkout path is `/Users/dev/auto-mobile`.
