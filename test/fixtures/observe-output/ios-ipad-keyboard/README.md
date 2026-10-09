# iPad keyboard capture

`observe-keyboard-up.json` is a minimized, sanitized extract of an iOS 26.5 iPad
observation from 2026-10-08. It retains the application's root class and bounds,
the `UIKeyboard → UIView("UIKeyboardLayoutStar Preview")` ancestry, and four
keyboard controls with their original classes, bounds, labels and selector IDs.
All app content, app identity, device/session IDs and timing metadata are removed.
The window metadata and 820 × 1180 point screen dimensions are retained.

The observed tap selected `s2-461eddd061a03b92`, the Q key at
`[87,905,152,969]`, with the default tap action. The provider refused it as covered
by the soft keyboard. The screenshot confirms Q is on the visible keyboard.
This refusal was separate from earlier append-text timeouts; allowing the tap
does not establish that text insertion works.

The source hierarchy SHA-256 is
`13fa591842f5e45ba7278065660b35374f9a5bf638a0410c004abfa2a3f34d5a`.
The retained provider source was `bffbac1e835b2ef370f0b0b1c139a4a459b2fc99`.

JSON alone omits the critical in-memory provenance. `ObserveScreen.identifyCapture`
registers `identifyObservedHierarchy` while retaining the original hierarchy.
For iOS, that registration projects a separate tree: `ResolverElementSelector`
selects from the snapshot, so collecting occlusion ancestry from the original
tree cannot match the selected node by source identity. The regression registers
that capture before using the real selector.

The app button added by the test is synthetic. It deliberately shares Q's label,
bounds and absent native resource ID, but sits outside the keyboard subtree and
has its own selector ID. It must remain blocked without dispatching a tap.
