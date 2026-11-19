# Fixture capture mode

Parser and contract fixtures under `test/fixtures/` must come from running AutoMobile's tools on a real device, emulator or simulator, with their provenance recorded (#18769). Fixture capture mode records the host commands each tool call runs, so a fixture can be recaptured by running the tool again instead of by hand.

## Switch

Capture is off unless `AUTOMOBILE_CAPTURE_FIXTURES_DIR` names a directory in the daemon's environment. With it unset, the tool registry runs each handler unwrapped and the exec seam finds no capture scope, so normal runs record nothing and write nothing. Use a private daemon for capture runs: the variable applies to every tool call the daemon serves.

## What is recorded

`ToolRegistry` opens one capture scope per tool call, for plain and device-aware tools alike, including tools that `executePlan` and other tools call internally. A nested tool call opens its own scope, so every command belongs to the innermost tool call that issued it. A device-aware call records the device it resolved.

Commands are recorded in `runExecSeam` (`src/utils/ExecSeam.ts`), the one exec path that `AdbClient`, the simctl/xcrun runners, `HostCommandExecutor`, `xcodebuild`, `security` and the emulator client share. Each command records its argv, working directory, stdout, stderr, exit code (or the signal or node error code for a command that never exited normally) and duration. Every recorded command ran on the host, so its output is a real capture.

Not recorded: long-lived spawned processes (`AdbClient.spawn`, streaming `screenrecord`/`logcat`), CtrlProxy WebSocket frames and XCTestRunner result frames. iOS CtrlProxy exchanges have their own recorder, `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`.

### Redaction at capture time

Owner policy is to redact nothing at capture time except text typed into a password field. A command that passes `AdbExecuteOptions.logLabel` (password typing, lock-screen PIN settings) is already kept out of logs, and runs under `withFixtureCaptureRedaction`, so its argv is recorded as the executable plus `<redacted:password-field>` and it is marked `redacted: true`. A redacted command cannot be promoted.

## On-disk format

Each tool call writes `<dir>/<tool>_<epoch-ms>_<id>/` once the call settles, whether it succeeded or threw:

- `provenance.json`: `schemaVersion`, `tool.name`, `captureDate` (ISO-8601 UTC call start), `automobileVersion` (a source checkout carries the commit as `+g<sha>[.dirty]`), and `device` when one was resolved: platform, device id, name, model, device type, form factor, OS version, API level, iOS version, runtime id.
- `commands.json`: the commands in issue order, each with `index`, `argv`, `cwd`, `exitCode`, `signal`, `errorCode`, `durationMs`, `stdout`, `stderr` and `redacted`.

A failure to write a capture is logged as a warning and never fails the tool call. A change to the format bumps `FIXTURE_CAPTURE_SCHEMA_VERSION`; the promote step accepts only the current version.

## Promotion

`scripts/fixtures/promote-capture.ts` copies one command's stdout or stderr from a capture into the tree:

```bash
bun scripts/fixtures/promote-capture.ts --capture "$DIR/measureStartup_<ms>_<id>" \
  --command 3 --dest test/fixtures/android-startup/phone/am-start-w.txt
```

- The destination must be `test/fixtures/<area>/<form-factor>/<name>.txt`. The form-factor directory is one of the device model's form factors (`phone`, `tablet`, `foldable`, `tv`, `watch`, `automotive`, `xr-headset`, `xr-glasses`). Only `.txt` is accepted, because oxfmt would rewrite a JSON or Markdown capture.
- The step refuses a capture without a device, without an OS version or API level, whose device reports a different form factor, or whose `automobileVersion` names no commit or a dirty checkout. A device that reports no form factor takes the directory's form factor, and the sidecar marks it `formFactorDeclared`.
- The device id becomes `<serial>` (Android) or `<udid>` (Apple platforms), the home directory becomes `~`, and the executable in argv becomes its basename.
- Next to the fixture it writes `<name>.provenance.json`: `provenance: "captured"`, tool, redacted argv, exit code, stream, capture date, source commit, AutoMobile version and the device's platform, form factor, model, device type, OS version, API level and runtime id. The sidecar is formatted with oxfmt.
- When `git check-attr eol` does not already report `lf` for the fixture, it adds `test/fixtures/<area>/<form-factor>/* text eol=lf` to `.gitattributes`, after the last entry for the same area (or the last `test/fixtures/` entry), so Windows checkouts keep the fixture byte-identical.
