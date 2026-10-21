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

# Captured Linux /proc fixtures (#11998)

`proc-<distro>-<case>-status.txt` (`text eol=lf`) and `proc-<distro>-<case>-cmdline.bin`
(`binary`, NUL-separated argv, raw kernel bytes) are real `/proc/<pid>/status` and
`/proc/<pid>/cmdline` reads, produced by `scripts/ci/linux-qualification/capture-proc-fixtures.sh`
in the Linux Qualification workflow (job `proc-fixtures`, GitHub Actions run 38862794590,
2026-10-16, runner kernel Linux 6.17.0-1022-azure x86_64). Nothing is edited or normalized.

- `alpine`: `alpine:3` (3.24.2, BusyBox 1.37.0), digest
  `sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6`.
- `debian`: `debian:stable-slim`, digest
  `sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5`.
- `normal`: `sleep 60` (alpine pid 13).
- `pid1`: container init `sh -s` (pid 1; alpine and debian).
- `comm-name`: a script literally named `my (proc) x`; `Name:` keeps spaces and parentheses (alpine pid 126).
- `argv0-spoof`: `exec -a "my (proc) x" sleep 60`; argv[0] changes while `Name:` stays `sleep` (debian pid 21; BusyBox did not capture it).
- `zombie`: an unreaped `sleep` child, empty cmdline and no `VmRSS` (alpine pid 144; debian reaped its child, so no capture).

Re-capture by downloading the run's `proc-fixtures` artifact
(`gh run download 38862794590 -n proc-fixtures`) or re-running that workflow job.
`proc-status-upstream-man-proc_pid_status.txt` above is still upstream documentation,
used by `processTableRetry.test.ts`; `procProcessTable.test.ts` no longer reads it.
