# Android XR headset sendKeys captures (#17801)

Captured, not hand-written: each file is a raw `sendKeys` tool run copied from
the issue comment, with host paths replaced by `<HOST_PATH>` (these runs had
none). The first line echoes the command, the JSON is the MCP response, and the
trailing lines are the CLI summary and exit code.

- Device: hand-created `system-images;android-34;google-xr;arm64-v8a` AVD with
  the `xr_headset_device` profile, CtrlProxy accessibility service running
- Daemon build: main `425fbb4b282`
- Screen: Settings search, `android:id/search_src_text` focused, Gboard default IME

| File                         | Run                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `auto-mode-gboard-fails.txt` | `type "wifi"` with no mode: `NO_FOCUSED_EDITABLE`; the observation shows Gboard and no readable focused editable field. |
| `a11y-mode-works.txt`        | `type "wifi"` with `mode: a11y`: succeeds.                                                                              |
