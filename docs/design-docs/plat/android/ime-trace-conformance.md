# InputConnection trace comparison

The Discover IC Trace screen records Android `InputConnection` calls as JSONL. `IcTraceComparison`
loads those lines and compares two captures in call order. It ignores elapsed time and sequence
numbers, while preserving the operation name, arguments, success result, text reads, selection, and
composing range. The scenario and editor settings must match. Keyboard ID and version are reported
as the two capture identities rather than required to match.

The comparator returns **inconclusive** when a capture is empty, malformed, reports evicted events,
or has a sequence gap. An incomplete capture cannot be treated as a passing or failing behavior
comparison. JSONL fields added after the original recorder format have defaults, so older exports
remain readable. Synthetic examples in `android/playground/discover/src/test/resources/ictrace/`
exercise a matching pair; they are fixtures, not measurements from either keyboard.

## Capturing a comparison pair

1. Install and enable Gboard and Samsung Keyboard on the same Android device. Record the Android
   build, keyboard package/version, and whether either keyboard has custom settings enabled.
2. Select the first keyboard in Android input settings, open Discover's IC Trace screen, enter a
   precise scenario name, and leave **Include text** off unless the scenario requires content-level
   comparison and the entered text is safe to export. The default capture records lengths rather
   than typed or read text.
3. Start from the same editor contents and selection for every capture. Perform the scenario once,
   check that the screen reports zero dropped events, and export the JSONL. Save it with the
   scenario and keyboard package/version in its filename.
4. Clear the recorder, switch keyboards in Android settings, return to the same trace screen, and
   repeat the exact scenario with the same editor setup. Export the second JSONL.
5. Pass both complete JSONL exports to `IcTraceComparison.compareJsonl` from Kotlin tooling or a
   test harness. The Discover screen currently exports traces but has no in-app import/compare
   screen. Review every reported field location; the first differing call often changes subsequent
   selection/composition state.

Useful first scenarios include inserting a word at the cursor, replacing a selected word, moving the
cursor into a word and backspacing, and submitting a multiline editor action. Capture each scenario
separately so call sequences are easy to interpret. Keep text capture disabled for ordinary
comparison: redacted `length=N` values cannot prove character equivalence, but they preserve privacy
and still allow comparison of operation order and editor state.

This comparator checks observable editor-call behavior only. A matching synthetic fixture or a
single device capture does not establish general keyboard equivalence. In particular, Samsung
behavior remains uncharacterized until repeatable physical-device captures are collected across
scenarios and relevant app/editor settings.
