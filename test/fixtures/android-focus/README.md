# Android focus fixtures (#9017)

Captured, not hand-written. Each file is the `viewHierarchy` member of a real
`observe` result (ObserveResult JSON), copied byte-for-value from the
tool-output artifact; only the other top-level observe keys
(`rawViewHierarchy`, `layoutWarnings`, `backStack`, ...) were dropped. No node
attribute was edited.

- Device: `am-api36-ga-arm64` emulator (`emulator-5600`), API 36, CtrlProxy 0.0.82
- Daemon build: main `a9d3fc38f` (includes the #8998 fix for #8997)
- Captured: 2026-10-03, manual-test batch 4
- App/screen: `dev.jasonpearson.automobile.playground`, Discover -> Text tab,
  after `launchApp {coldBoot:true}` then `tapOn {selector:{text:"Text"}}`

| File                                  | Moment                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playground-text-field-pre-tap.json`  | Before `sendKeys`/`tapOn focus` on `Basic Text Field`. The empty `EditText` at `[84,1115][996,1262]` has no `text`; its label is a child `TextView`. |
| `playground-text-field-post-tap.json` | After the tap. The same field is `focused`, still empty, with a new `s2-` view-id.                                                                   |

The property the fixtures exist to preserve: CtrlProxy returns the app content
twice, under `hierarchy` and under `windows[n].hierarchy`, as separate
deserialized objects. The `EditText` therefore appears as two entries with
different `source` references, which the #8998 test (one shared object) never
exercised.
