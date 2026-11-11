# Android TV session tool discovery (#18029)

Captured, not hand-written: `tv-session-tools.json` holds the two payloads
reported in #18029, copied value for value (only whitespace changed).

- `toolsListNames`: the `tools/list` names after an Android TV session was
  acquired (`getAndroid` ready, `formFactor: "tv"`), 26 tools.
- `toolCatalogEntries`: the `automobile:tools` resource entries for the tools
  missing from that list, plus two listed ones (`observe`, `tapOn`).

- Device: `system-images;android-36;android-tv;arm64-v8a` AVD (`tv_1080p`, emulator-5558)
- Daemon build: main `a14b2e6ef40`, private daemon, found while working #16739
