# Android Settings search clear evidence

Captured during int-r7 at SHA `44eebb9481`, on an emulator running API 37,
in the Settings search view. Files were copied unchanged from
`verify/int-r7/evidence/ios-r7/android/`.

`clear-hint-resp.json` is the real failing setUIState response.
`gt-before-clear.txt` and `gt-after-clear.txt` contain the uiautomator text/hint
attribute ground truth for all nodes before and after clearing.
No raw view-hierarchy dump was captured. The observe skeleton is not a raw hierarchy.

Unit tests build their Element from the captured attribute values, using resource-id
`com.google.android.settings.intelligence:id/open_search_view_edit_text` and class
`android.widget.EditText`. They read the non-empty hint pair from these text files,
map `hint` to the hierarchy property `hint-text`, and supply test bounds and editable
metadata. These constructed nodes are test adapters, not captured parser fixtures.
