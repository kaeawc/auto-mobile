# Fixture capture mode

Parser and contract fixtures under `test/fixtures/` must come from running AutoMobile's tools on a real device, emulator or simulator, with their provenance recorded (#18769). Fixture capture mode records the host commands each tool call runs, so a fixture can be recaptured by running the tool again instead of by hand. The reasoning behind the design is in [Fixture capture mode](../devlog/2026-11-20-fixture-capture-mode.md).

## Switch

Capture is off unless `AUTOMOBILE_CAPTURE_FIXTURES_DIR` names a directory in the daemon's environment (a relative path resolves against the daemon's working directory). With it unset, the tool registry runs each handler unwrapped and the exec seam finds no capture scope, so normal runs record nothing and write nothing. Use a private daemon for capture runs: the variable applies to every tool call the daemon serves.

## What is recorded

`ToolRegistry` opens one capture scope per tool call, for plain and device-aware tools alike, including tools that `executePlan` and other tools call internally. A nested tool call opens its own scope, so every command belongs to the innermost tool call that issued it. A device-aware call records the device it resolved.

Commands are recorded in `runExecSeam` (`src/utils/ExecSeam.ts`), the one exec path that `AdbClient`, the simctl/xcrun runners, `HostCommandExecutor`, `xcodebuild`, `security` and the emulator client share. Each command records its argv, working directory, stdout, stderr, exit code (or the signal or node error code for a command that never exited normally) and duration. Every recorded command ran on the host, so its output is a real capture.

A scope closes when its capture is written, and a closed scope records nothing more. Background work a call starts can keep its async context after the call returns, so without this a repeating loop would keep adding commands to a finished capture. The performance sampler's 500 ms interval also runs its ticks under `outsideFixtureCapture`, so its commands are never attributed to the call that armed it.

### Size limits

Each stream of a command keeps at most `MAX_CAPTURED_STREAM_CHARS` (1 MiB, node's default `maxBuffer`) characters. One tool call keeps at most `MAX_CAPTURED_CALL_CHARS` (8 MiB) of stdout plus stderr across all its commands. A stream that either limit cuts ends in `<truncated:fixture-capture-limit>`, and its command gets `truncated: true`. The writer spends the call limit in issue order, so when concurrent commands finish out of order, the highest `index` still loses output first. Once a call's limit is used up, later commands keep their argv and exit code, but their output is empty and truncated. A command that overflowed node's `maxBuffer` (`errorCode` `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) keeps only the output node handed back. That output can be exactly the stream limit, so the command gets `truncated: true` even without the marker. Promotion refuses a truncated command.

Not recorded: long-lived spawned processes (`AdbClient.spawn`, streaming `screenrecord`/`logcat`), CtrlProxy WebSocket frames and XCTestRunner result frames. iOS CtrlProxy exchanges have their own recorder, `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`.

### Redaction at capture time

Owner policy is to redact nothing at capture time except text typed into a password field. A command that passes `AdbExecuteOptions.logLabel` (password typing, lock-screen PIN settings) already stays out of logs and runs under `withFixtureCaptureRedaction`. Its argv becomes the executable plus `<redacted:password-field>`, and the command gets `redacted: true`.

A caller that scrubs secrets from its own logs applies the same scrubber to the capture with `withFixtureCaptureScrub`. bundletool `build-apks` output can echo keystore passwords, so it runs under `scrubBundletoolText`. The scrubber replaces the passwords in argv, stdout and stderr before any truncation, and a command whose text it changed gets `redacted: true`. Promotion refuses a redacted command.

## On-disk format

Each tool call writes `<dir>/<tool>_<epoch-ms>_<id>/` once the call settles, whether it succeeded or threw:

- `provenance.json`: `schemaVersion`, `tool.name`, `captureDate` (ISO-8601 UTC call start) and `automobileVersion` (a source checkout carries the commit as `+g<sha>[.dirty]`). It also holds `sourceTreeState`: `clean`, `dirty` or `unknown`. The writer awaits the daemon's dirty-state probe first, and a probe that failed or timed out gives `unknown`. When the call resolved a device, `device` holds its platform, device id, name, model, device type, form factor, OS version, API level, iOS version and runtime id.
- `commands.json`: the commands in issue order, each with `index`, `argv`, `cwd`, `exitCode`, `signal`, `errorCode`, `durationMs`, `stdout`, `stderr`, `redacted` and `truncated`.

A failure to write a capture is logged as a warning and never fails the tool call. A change to the format bumps `FIXTURE_CAPTURE_SCHEMA_VERSION`; the promote step accepts only the current version.

## Promotion

`scripts/fixtures/promote-capture.ts` copies one command's stdout or stderr from a capture into the tree:

```bash
bun scripts/fixtures/promote-capture.ts --capture "$DIR/measureStartup_<ms>_<id>" \
  --command 3 --dest test/fixtures/android-startup/phone/am-start-w.txt
```

- The destination must be `test/fixtures/<area>/<form-factor>/<name>.txt`. The form-factor directory is one of the device model's form factors (`phone`, `tablet`, `foldable`, `tv`, `watch`, `automotive`, `xr-headset`, `xr-glasses`). Only `.txt` is accepted, because oxfmt would rewrite a JSON or Markdown capture.
- `sourceTreeState` is `dirty` for modified tracked files only: the probe ignores untracked files, so a new untracked file under `src/` or `scripts/` still reads `clean`. Commit or stash new files before a capture run.
- The step refuses a capture without a device or without an OS version or API level. It also refuses one whose device reports a different form factor, whose `automobileVersion` names no commit or a dirty checkout, or whose `sourceTreeState` is not `clean`. It refuses a redacted or truncated command. A device that reports no form factor takes the directory's form factor, and the sidecar marks it `formFactorDeclared`.
- The device id becomes `<serial>` (Android) or `<udid>` (Apple platforms), the home directory becomes `~`, and the executable in argv becomes its basename.
- Next to the fixture it writes `<name>.provenance.json`: `provenance: "captured"`, tool, redacted argv, exit code, stream, capture date, source commit and AutoMobile version. The sidecar also holds the device's platform, form factor, model, device type, OS version, API level and runtime id, and oxfmt formats it.
- When `git check-attr eol` does not already report `lf` for the fixture, it adds `test/fixtures/<area>/<form-factor>/* text eol=lf` to `.gitattributes`. The line goes after the last entry for the same area (or the last `test/fixtures/` entry), so Windows checkouts do not convert the fixture to CRLF. The pin also makes git normalise line endings on commit. A capture with CRLF line endings (older-API `adb shell` output) is stored and checked out with LF, so the committed fixture is not byte-identical to that capture.
