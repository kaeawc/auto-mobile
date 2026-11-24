# `sendKeys`

| Tool                     | What it does                                                      | Platforms                                                                                                                                                                                                                                                                                                                                               | Needs                             |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🔤 <code>sendKeys</code> | Execute ordered typing, clear, raw-key, and semantic IME commands | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span> <span role="img" aria-label="watchOS" title="watchOS">⌚</span> <span role="img" aria-label="tvOS" title="tvOS">📺</span> <span role="img" aria-label="visionOS" title="visionOS">🥽</span></span> | <span class="tool-needs">—</span> |

`sendKeys` runs an ordered list of `type`, `key` and `clear` commands, optionally
after focusing a field with `selector`.

## Key commands

`{ "action": "key", "key": "<name>", "modifiers": [...] }` presses one key.

- `key` is a raw key (`enter`, `tab`, `escape`, `backspace`, `delete`,
  `arrow_up`, `arrow_down`, `arrow_left`, `arrow_right`) or a lowercase letter `a`
  to `z`. It can also be a semantic IME key (`next`, `previous`, `done`, `search`,
  `send`, `go`).
- `modifiers` holds `shift`, `ctrl`, `alt` and `meta` (Command on iOS). Semantic
  IME keys ignore them.

## Keyboard shortcuts

A letter with modifiers is a keyboard shortcut:

| Shortcut                                | Command                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| Go home (iOS)                           | `{ "action": "key", "key": "h", "modifiers": ["meta"] }`        |
| Show the dock (iPad)                    | `{ "action": "key", "key": "d", "modifiers": ["meta", "alt"] }` |
| Select all in a focused field (Android) | `{ "action": "key", "key": "a", "modifiers": ["ctrl"] }`        |

- **iOS simulator:** the chord is sent as the simulator's hardware keyboard, so
  system shortcuts reach SpringBoard and no text field needs focus. The result
  does not confirm what the shortcut did; observe the screen afterwards. The
  exception is `meta+h`: it succeeds only once the home screen shows, and fails
  with "was not delivered" on a simulator that ignores it (iPhone Duo). Use
  `homeScreen` or `pressButton home` there.
- **iOS physical device:** a key command needs a focused text field. Without
  one, the command fails; tap a field first or pass `selector`.
- **Android:** a letter without modifiers is a key event. A chord needs Android
  API 31 or later; older devices return an error naming the API level.

On an iOS device, every other key command needs a focused text field: a letter
without modifiers, and `enter`, `tab`, `escape`, `backspace`, `delete` or an
arrow.

On an iOS simulator, key commands go to the simulator's hardware keyboard
directly, so success means the simulator took the key. A text key with no
focused field does nothing. Observe to check it landed. A shortcut such as
`meta+alt+d` can still act without a focused field. `meta+h` and the
`next`/`done`/`search`-style keys still use the runner, and so does `type` text.
Set `AUTOMOBILE_DISABLE_IOS_SIM_HID=1` to send every key through the runner.
