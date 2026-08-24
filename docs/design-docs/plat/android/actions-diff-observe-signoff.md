# `--actions-diff-observe` — real-device diff-format sign-off

Closes the acceptance item carried by **#3026 / #2761** that a unit test alone
cannot satisfy:

> Diff output format signed off on first real output before finalizing.

Tracked by **#3051**. The merged plumbing (`--actions-diff-observe`, PR #3034)
emits, for a non-observe action on an unchanged screen, only the _diff_ of the
post-action observation against the previous one:

```
{ isDiff: true, added, removed, changed, fields }
```

- `added` / `removed`: `{ key, attributes }` — the full node attributes, so a
  new/gone node is reconstructable without the baseline.
- `changed`: `{ key, changes: { <attr>: { from, to } } }` — a key-matched node
  whose non-key attributes changed.
- `fields`: changed top-level scalars + the Element mirror fields
  (`focusedElement` / `accessibilityFocusedElement` / `awaitedElement`, #3052),
  each `{ from, to }`.

Impl: `src/features/observe/output/ObserveResultOutput.ts` (`diffObserveResult`),
`src/server/finalizeToolResponse.ts`.

## Method

The shared MCP daemon runs the **main** build with the flag **off**, so a live
end-to-end `--actions-diff-observe` daemon run can't exercise this branch's diff
code. Instead the diff code was driven against **genuine emulator captures** of
the AutoMobile Playground app (`dev.jasonpearson.automobile.playground`,
`Medium_Phone_API_35`) through the same
`sanitizeObserveResult → diffObserveResult` path `finalizeToolResponse` uses.

Captured pairs (committed under `test/fixtures/observe/diff/`, post-sanitize form,
diff-irrelevant heavy fields removed):

| Pair                                    | Interaction                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `text-input-empty` → `text-input-typed` | focus a field + type `SignOff3051` (keyboard-stable) |
| `scroll-before` → `scroll-after`        | ~250px content scroll of a stably-identified list    |

Pinned as executable assertions in
`test/features/observe/output/diffObserveRealDevice.test.ts`.

## Findings

### 1. Shape revision required: volatile `extras` metadata flooded `changed`

The raw diff was **not** agent-consumable. On the text-entry pair the diff had
**85 `changed` entries — 83 of them pure churn** in the `extras` node attribute,
a bag of `AccessibilityNodeInfo` SDK metadata:

- `androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY` —
  an empty `"[]"` that appears/disappears on capture-timing races.
- `android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL` — a
  traversal-order index that shifts whenever the tree changes.
- `AccessibilityNodeInfo.roleDescription` — intermittently present.

These churn between two captures of the _same_ screen and are not actionable UI
deltas, so they buried the two real changes.

The wire serializer (`stringifyToolResponse`, `src/utils/toolUtils.ts`) strips
any key literally named `extras`, so on the **text** representation the 83 churn
entries land as empty-`changes` husks (`{ key, changes: {} }`) — still 85
entries burying the 2 real ones — while `structuredContent` (set directly, not
run through that serializer) carries the full `extras` objects. So the flood is
real in both representations; stripping at serialize-time does not fix it.

**Fix (this PR):** `DIFF_IGNORED_ATTRS = { "extras" }` — `extras` is excluded
from **both** volatile-prone diff paths (a later follow-up, #3228, added `view-id`
to this set; the current value in `ObserveResultOutput.ts` is
`{ "extras", "view-id" }` — see the Follow-ups section): the per-node _changed_ comparison
(`diffAttributes`) and the Element mirror fields (`leanElementForDiff`, so a
stable focus with only `extras` churn no longer emits a phantom
`fields.focusedElement`). Phantom entries are never emitted at all (no empty
husks, no `structuredContent` bloat). `added`/`removed` still carry the full node
(incl. `extras`) for reconstruction, `extras` is never part
of the node identity key, and the top-level `fields` diff is untouched. Result
on the same real pair: **85 → 2 `changed`** entries, both genuinely actionable.

### 2. AC#1 (agent-consumable) — PASS for localized actions, with caveats

After the fix the text-entry diff is a compact handful: `added=1, removed=3,
changed=2` plus a `focusedElement` field change — small enough to act on without
the full tree, and the new `EditText` carries its typed text in `added`
(reconstructable from the diff alone). Two honest limits:

- **The node `key` is not always a semantic handle.** It is
  `[resource-id, bounds, text, sibling-index]` NUL-joined (`\x00`). For a node
  with a `resource-id`/`text` it reads fine; for an id-less/text-less node it
  degrades to `bounds + index` — opaque (the consumer can't name what it is) and
  awkward to display (embedded NUL bytes render blank). So the key is _stable and
  unique_, not universally _human-legible_.
- **Typing surfaces as remove+add, not a `text` `changed`** (see AC#2).

### 3. AC#2 (`changed` fires with `{from,to}`) — PARTIAL on real output

- **`focused` — demonstrated on real data.** The `focusedElement` mirror
  (#3052) reports the newly-focused field with the typed value on the `to` side
  (`text: "SignOff3051"`), `node` subtree stripped. Note this rides the top-level
  `fields` map, not a node `changed` entry.
- **`checked` / `selected` — NOT reproduced on real output**, only covered by
  the synthetic tests (`diffObserveResult.test.ts`). The Playground toggles
  surface no state delta (finding #3 caveat below), so the classic
  `checked: false→true` `changed` could not be captured live. On real data,
  AC#2 is therefore **1 of 3 enumerated states** (`focused`).
- **Text edits are remove+add, not `changed.text`.** Because `text` is part of
  the node identity key, editing a field's text changes its key: the empty field
  lands in `removed` and the typed field in `added` — there is no
  `changed: { text: { from, to } }`. A consumer that wants the typed value reads
  it off the `added` node (or correlates the removed+added pair by bounds). This
  is the documented content-key limitation (`diffObserveResult.test.ts`: "a
  content-key field change reads as remove+add"), surfaced here on real output.
- Node `changed` entries that _do_ fire are clean `{from,to}` on actionable
  attributes (`content-desc`, `bounds`).

> Caveat — **Compose toggle state is not surfaced.** Tapping the Playground
> `Switch` / `CheckBox` returned success but produced **no** hierarchy delta:
> their state rides in a _static_ `content-desc` ("Switch is off") and no
> `checked`/`selected`/`stateDescription` attribute is extracted. So the
> classic `checked: false→true` `changed` (well-covered by the synthetic tests)
> did **not** reproduce on this app. This is a **capture-layer** limitation
> (what CtrlProxy extracts for Compose toggles), not a diff-format defect, and is
> orthogonal to the flag. The `focused` state change _is_ surfaced, so AC#2's
> "focused" example holds.

### 4. AC#3 (scroll cascade) — content identity helps, motivates stable IDs

On a ~250px scroll, content identity (#3053, default on) re-paired **9 shifted
rows** carrying stable `resource-id`s into compact **bounds-only `changed`**
deltas instead of remove+add. Churn dropped from **65** (positional-only) to
**56**. But the re-pair only helps rows with a stable id: of the residual 56
entries, **~28 are opaque** (id-less _and_ text-less — just `bounds + index`),
so an agent can't tell what entered/left the screen. That opacity — not just the
raw churn count — is the concrete motivation for the stable-node-identity
follow-up (**#3107**). Not a blocker for an off-by-default flag.

> **#3107 resolution (this data).** The `structuralIdentity` prototype (#3088
> limitation 1, keyed on `resource-id`/`view-id` only) was _not_ the fix for this
> opacity: those ~28 residual entries are **id-less _and_ text-less**, so a
> structural key is `null` for them and they fall back to positional remove+add
> regardless. The prototype only collapses in-place edits of nodes that already
> carry an id — a marginal win over the shipped content-identity diff — while
> adding a real false-merge surface on recycled `resource-id`s. It was therefore
> **removed** (not adopted, not wired to a CLI flag). The genuine fix for scroll
> opacity is real stable node identity emitted by the **capture layer**, which is
> orthogonal to the diff format. See "Decision" below.

### 5. AC#4 (byte/token reduction) — PASS for localized, bounded for scroll

Measured with the production `stringifyToolResponse` formatter + cl100k_base.
These are the **pre-#3228 baseline** figures (captured when this sign-off landed);
the capture-layer stable-identity work in #3228 shifted them slightly (scroll
improved to roughly `26%`/`59%`). Treat them as the order-of-magnitude result —
localized is a large win, scroll a smaller-but-real one — not exact current
values, which drift as the diff/identity layers evolve:

| Pair                   | diff / full (bytes) | diff / full (tokens) |
| ---------------------- | ------------------: | -------------------: |
| Text entry (localized) |           **~1.8%** |            **~4.4%** |
| Scroll (~250px)        |                ~29% |                 ~64% |

The localized case comfortably meets the fixture's `<10%` target (98% byte
reduction), matching the synthetic `android-home.json` measurement. A **scroll is
a real but much smaller win** — it shifts/enters/leaves many rows, so its diff is
a large fraction of the full observation. Still a reduction, never an inflation.

## Recommendation

**Sign off the diff shape** `{ isDiff, added, removed, changed, fields }` as the
**plumbing for localized actions**, **with the `extras`-exclusion fix landed**.
What this sign-off does and does not establish:

- **Established:** the shape is compact and consumable for localized actions
  (tap/type/focus) with ~95–98% output reduction on real device output; the
  `extras` flood is fixed; scroll behavior and its content-identity win are
  quantified.
- **Bounded / deferred to the capture layer:** full agent-consumability across
  _all_ the interaction states the issue enumerated is not yet reached — real
  toggle state (`checked`/`selected`) is not surfaced by the capture layer (so
  it is synthetic-only here), typing reads as remove+add rather than a `text`
  delta, and id-less nodes carry opaque keys that a scroll exposes in bulk. The
  #3107 revisit (see "Decision" below) confirmed the diff-format side of this is
  as good as it gets without real stable ids from capture.
- The flag stays **off by default**; its clearest wins are localized-change
  interaction loops. Scroll-heavy loops benefit less until **capture-layer**
  stable node identity collapses more of the cascade — a diff-format toggle
  (the removed `structuralIdentity` prototype) cannot, since the opaque rows
  carry no id to key on.

## Decision (#3107)

Revisiting the two limitations deferred in #3088/#3080 with the real-device data
above:

1. **`structuralIdentity` prototype (limitation 1) — removed.** The data shows it
   does not address the scroll bottleneck (id-less/text-less nodes get a `null`
   structural key and never re-pair) and only marginally helps in-place edits of
   already-id'd nodes, while adding a real false-merge surface on recycled
   `resource-id`s. Never adopted, never wired to a CLI flag — kept as dead
   scaffolding it is not (YAGNI). `structuralIdentityKey`, the
   `DiffObserveConfig.structuralIdentity` toggle, and
   `structuralIdentityDiff.test.ts` were deleted. Default behavior (content
   identity) is unchanged. The real scroll fix is **capture-layer stable node
   identity**, tracked separately.
2. **Pre-move key (limitation 2) — implemented.** `ObserveDiffNodeChange` now
   carries an optional `fromKey` (the baseline-side key) on **re-paired** entries
   only, so a consumer can locate a moved node in the baseline. Positionally
   matched entries omit it (their `key` already serves both sides). Pinned by
   `diffObserveResult.test.ts`.

### Follow-ups

### Addendum: occlusion-metadata stability ([#4399](https://github.com/kaeawc/auto-mobile/issues/4399))

The Android occlusion pass is enabled by default and emits
`occlusionState`/`occludedBy`/`occludedByViewId` on hierarchy nodes. The
capture-layer stable-identity code already excludes these fields because they
can churn between captures of the same screen. The action-diff comparison now
uses the same policy: matched-node deltas and Element mirror fields ignore all
three attributes. `SafeAreaAuditor` derives a warning's `confidence` from
`occlusionState`, so the diff also treats a confidence-only `layoutWarnings`
change as unchanged; any material warning change remains emitted.

**Android emulator sign-off (2026-07-25):** with a branch daemon running
`--actions-diff-observe` (safe-area layout warnings were an opt-in
`--safe-area-warnings` flag at the time; they are now always emitted) and
occlusion enabled, two
consecutive real Android emulator captures were fed through the same
`sanitizeObserveResult → diffObserveResult` path used by
`finalizeToolResponse`. The output had `added=0`, `removed=0`, `changed=0`, and
no `fields`. This sample did not itself exhibit the documented nondeterministic
occlusion churn, so the exact churn suppression is pinned by the deterministic
unit regressions in `diffObserveResult.test.ts`: node-only churn, mirror-only
churn, and `layoutWarnings.confidence`-only churn produce no diff, while a real
node or warning change remains visible. `recompositionMetrics` remains diffed;
there is no evidence that it is volatile.

- Capture-layer: emit real stable node identity so scroll diffs collapse the
  id-less/text-less cascade (the residual opacity in §4) — the genuine fix
  #3107 pointed at, orthogonal to the diff format. **Landed as #3228**: the TS
  ingest (`assignStableViewIds`, `src/features/observe/android/StableNodeIdentity.ts`)
  rewrites the runner's path-derived UUID `view-id`s into content-derived
  stable ids (Merkle hash of stable subtree content, ordinal-suffixed for
  content-identical duplicates), and `view-id` joined `extras` in
  `DIFF_IGNORED_ATTRS`. On this scroll pair the opaque residuals drop 28 → 4,
  churn 56 → 40, and the diff share falls to ~26% bytes / ~59% tokens (pinned
  by `test/features/observe/output/stableIdentityScrollDiff.test.ts`).
- Capture-layer: surface Compose toggle state (`checked`/`selected`/
  `stateDescription`) in the extracted hierarchy so state toggles diff as
  `changed` on real Compose apps (**#3139**).
