Fixtures for `src/features/bootAdmission` (#11588).

- `ps-snapshot-two-emulators-with-ports.txt`: kept rows of one
  `ps -axo pid=,ppid=,rss=,pcpu=,command=` capture, macOS 26 (Darwin 25.6), Android Emulator
  37.1.11, 2026-10-13. Two AutoMobile broker-binding emulators ran: pid 75134, windowed
  `qemu-system-aarch64 ... -port 5556`, and pid 83205, `qemu-system-aarch64-headless ... -port 5554`.
  Both were reparented to pid 1. Their `crashpad_handler`/`netsimd` helpers and an
  `adb -s emulator-5556 logcat` decoy are also retained. Kept rows only; no row is synthetic.
  Redactions: user name replaced with `dev`.

- `ps-snapshot-one-running-emulator.txt`: rows of one `ps -axo pid=,ppid=,rss=,pcpu=,command=`
  capture (macOS 26, Android Emulator 37.1.11, 2026-10-10) taken while an AutoMobile daemon ran one
  headless emulator it had booted. Kept rows: `launchd`, `logd`, `syslogd`, a Chrome crashpad
  helper (a path with spaces and ` --` arguments), the daemon (pid 61847), its emulator's
  `qemu-system-aarch64-headless` process (pid 67978, whose parent IS the daemon: the `emulator`
  launcher the daemon spawned became the qemu process), and the emulator's `crashpad_handler` and
  `netsimd` helpers. Every other row of the capture was dropped. No row is synthetic. Redactions
  only: the user name in `/Users/<name>` and `/tmp/android-<name>` is `dev`, and the daemon's
  checkout path is `/Users/dev/auto-mobile`.

- `proc-status-upstream-man-proc_pid_status.txt`: lines 23–54, byte-for-byte, of
  https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man5/proc_pid_status.5.
  This is UPSTREAM DOCUMENTATION, not a capture from a running host; Docker was not running on
  the lane host. Follow-up (#11965): replace with a capture from the project's Alpine image,
  using `cat /proc/<pid>/status` and `/proc/<pid>/cmdline` of a controlled short-lived process.

# Owed: Linux /proc captures (#11998, #11965)

`proc-status-upstream-man-proc_pid_status.txt` is upstream documentation, not
a capture from a running Linux process. Capture real process fixtures with
`scripts/capture-proc-fixtures.sh [out-dir]` (default:
`test/fixtures/android-boot-admission`). The script writes:

- `proc-alpine-status.txt`, `proc-alpine-cmdline.bin`, and `proc-alpine-pid1-status.txt`
- `proc-debian-status.txt`, `proc-debian-cmdline.bin`, and `proc-debian-pid1-status.txt`
- `proc-alpine-provenance.txt` and `proc-debian-provenance.txt`

Once captured, `test/features/bootAdmission/procProcessTable.test.ts` must
switch to these captured files. No capture was made on the lane host.
