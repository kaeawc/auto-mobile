# Compose interop hidden-region text heuristic — evaluation

Tracks the decision requested in [#2634](https://github.com/kaeawc/auto-mobile/issues/2634),
following [#2619](https://github.com/kaeawc/auto-mobile/pull/2619) which introduced the
`contentHiddenRegions` signal.

## Background

`ViewHierarchyExtractor` flags likely Compose `AndroidView` interop regions where the
accessibility tree hides rendered descendants. A candidate boundary is reported when it is:

- a descendant of a `ComposeView`,
- large enough (`> MIN_HIDDEN_REGION_SCREEN_AREA`, 25% of the screen),
- non-interactive, and
- sparsely covered by its direct children (`<= MAX_VISIBLE_CHILD_COVERAGE`, 25%).

The original gate also rejected the candidate when **any** descendant carried `text` or
`contentDesc`:

```kotlin
if (countTextBearingNodes(node) > 0) {
  return false
}
```

This recursive reject is the subject of #2634.

## The problem with the recursive reject

Real Compose interop screens routinely expose a *small* accessibility-visible affordance —
most commonly a toolbar / app-bar title — while the bulk of the interop content
(a Fragment + `RecyclerView`, a `WebView`, a media surface) stays inaccessible. The
recursive reject discards the entire region the moment that single title is present,
producing a **false negative**: the screen that most needs the hidden-region signal is the
one the heuristic stays silent on.

## Examples evaluated

The on-device app set available during evaluation does not include a Compose `AndroidView`
interop screen (no Slack-like Fragment/RecyclerView host), so live capture of
`contentHiddenRegions` was not possible here. The corpus below is built from the canonical
case the issue describes, using realistic Slack-like geometry consistent with the existing
`com.slack:id/top_bar` regression fixture (1440×3000 screen).

| # | Screen | Region bounds | Area % | Visible child | Child coverage | Truth | Recursive reject | Option 1 |
|---|--------|---------------|--------|---------------|----------------|-------|------------------|----------|
| 1 | Slack-like channel, empty interop body | `0,368–1440,2752` | 79% | none | 0% | hidden (TP) | reports ✅ | reports ✅ |
| 2 | Slack-like channel, **toolbar title visible** | `0,368–1440,2752` | 79% | `top_bar` "general" `0,290–1440,458` | ~3.8% | hidden (TP) | **silent (FN)** ❌ | reports ✅ |
| 3 | Candidate boundary itself labeled | `0,368–1440,2752` | 79% | n/a (own `contentDesc`) | — | not a hidden body (it *is* the content) | silent ✅ | silent ✅ |
| 4 | Mostly-accessible list, sparse hidden gaps | `0,368–1440,2752` | 79% | dense text rows covering ~60% | ~60% | visible (FP risk) | silent ✅ | silent ✅ (coverage gate) |
| 5 | Interactive interop surface (clickable) | `0,368–1440,2752` | 79% | n/a (interactive) | — | interactive, not reported | silent ✅ | silent ✅ |

Example 2 is the motivating false negative. Example 4 is the false-positive risk that Option 1
must not regress — it is held back by the existing `directChildCoverage` gate, not by descendant
text counting.

## Decision

**Adopt Option 1: reject only when the candidate boundary node itself carries `text` or
`contentDesc`.** Descendant text is allowed to coexist with a hidden-region report; the
`MAX_VISIBLE_CHILD_COVERAGE` direct-child-coverage gate remains the guard against regions
that are actually mostly visible (Example 4).

Rationale:

- Fixes the documented false negative (Example 2) — the single most valuable interop case.
- Smallest change; keeps the detector fast and the output additive (no node visibility or
  bounds are mutated).
- Does not introduce new tunables. Option 2 (coverage-weighting descendant text) adds a
  second area computation, double-counting decisions for overlapping descendants, and more
  test surface — premature without a corpus of real failures that the coverage gate cannot
  already separate. Per the issue recommendation, Option 2 is deferred.

## Follow-up

If live capture later surfaces regions where descendant text is sparse in bounds yet
semantically substantial (a long single-line caption over an otherwise hidden media surface),
revisit Option 2 with that concrete corpus. Until then the coverage gate is the safety net.
