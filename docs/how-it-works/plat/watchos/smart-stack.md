# watchOS Smart Stack cells

With the Smart Stack open, `XCUIApplication(bundleIdentifier: "com.apple.clockface").debugDescription`
lists the stack as `Cell` elements. The parser turns that text dump into the
same hierarchy envelope the watch runner sends, so it goes through the same
normalizer and element model as an app hierarchy. Bounds stay in points, and
the screen size comes from the first `Window` frame.

## Cell contract

| Element                                                           | Meaning                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Other` with identifier `Smart Stack Header`                      | Date and time buttons. Their labels are read in order.           |
| `Cell` with identifier `StackCollectionViewComplicationCell -- …` | A third-party widget. The element gets role `widget`.            |
| `Cell` with any other `StackCollectionView<Kind>` identifier      | A system card, such as `TriPlatterCell`, kept as a generic card. |

A widget identifier has the form
`StackCollectionViewComplicationCell -- <cell uuid> -- <app name> -- <widget display name> -- <host bundle id> -- <descriptor>`.
The descriptor ends in `-<n>`. In the captured form it is
`<host>-<extension bundle id>-<kind>-<n>`. The extension bundle id and kind are
reported only when the extension id starts with the host id plus `.`. In that
case the kind starts at the first `-` after the extension id. In every other
case only the raw descriptor and `n` are reported.

The uuid, the bundle id and the descriptor never contain `--`, so the parser
reads fields from both ends. A `--` inside the app name or the widget name is
resolved with the cell's first label, which is the app name. Without that label,
the extra text stays in the widget name.

A widget's own text is the set of its `StaticText` labels. Right after a widget
is added, the cell holds only its app-name label, and the text appears after the
timeline renders. A caller that needs the text must therefore poll. System card
text is every distinct label inside the card.

The fixtures under `test/fixtures/watchos-clockface/` are verbatim watchOS 26.5
captures, and time labels contain U+202F before `PM`.
