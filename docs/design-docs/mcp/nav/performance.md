# Performance

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** Benchmarked. Navigation ID path ~1ms, Shallow Scrollable ~5–10ms. See the [Status Glossary](../../status-glossary.md) for chip definitions.

### Performance

- **Navigation ID**: ~1ms (simple extraction + hash)
- **Shallow Scrollable**: ~5-10ms (filtering + hash)
- **Cached ID**: ~1ms (no hierarchy processing)

---

### Expected Reliability by Scenario

These are the strategy's _design expectations_, not figures from a committed
benchmark (no such dataset exists in the repo — see the note in
[Fingerprinting](fingerprinting.md#design-foundation)):

| Scenario               | Strategy           | Expected reliability | Notes                                |
| ---------------------- | ------------------ | -------------------- | ------------------------------------ |
| SDK app, no keyboard   | Navigation ID      | High                 | Explicit navigation identifier       |
| SDK app, with keyboard | Cached Nav ID      | High                 | Keyboard occlusion handled via cache |
| Scrolling content      | Shallow Scrollable | High                 | Container metadata stays stable      |
| Tab navigation         | Shallow Scrollable | High                 | Selected state preserved             |
| Non-SDK app            | Shallow Scrollable | Moderate             | Depends on hierarchy distinctiveness |

#### Overall Design Expectations

- **Non-keyboard scenarios**: high reliability by design (explicit or structural IDs)
- **Keyboard scenarios**: depends on cache availability
- **Collision avoidance**: selected-state disambiguation (unit-tested)
