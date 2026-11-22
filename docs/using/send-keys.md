# `sendKeys`

| Tool                     | What it does                                                      | Platforms                                                                                                                                                                                                                                                                                                                                               | Needs                             |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🔤 <code>sendKeys</code> | Execute ordered typing, clear, raw-key, and semantic IME commands | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span> <span role="img" aria-label="watchOS" title="watchOS">⌚</span> <span role="img" aria-label="tvOS" title="tvOS">📺</span> <span role="img" aria-label="visionOS" title="visionOS">🥽</span></span> | <span class="tool-needs">—</span> |

`sendKeys` runs an ordered list of `type`, `key` and `clear` commands, optionally
after focusing a field with `selector`.

## Key commands

`{ "action": "key", "key": "<name>", "modifiers": [...] }` presses one key.

- `key` is a raw key (`enter`, `tab`, `escape`, `backspace`, `delete`,
  `arrow_up`, `arrow_down`, `arrow_left`, `arrow_right`), a lowercase letter `a`
  to `z`, or a semantic IME key (`next`, `previous`, `done`, `search`, `send`,
  `go`).
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
  does not confirm what the shortcut did; observe the screen afterwards.
- **iOS physical device:** a key command needs a focused text field. Without
  one, the command fails; tap a field first or pass `selector`.
- **Android:** a letter without modifiers is a key event. A chord needs Android
  API 31 or later; older devices return an error naming the API level.

On iOS, every other key command needs a focused text field: a letter without
modifiers, and `enter`, `tab`, `escape`, `backspace`, `delete` or an arrow with
or without modifiers.
