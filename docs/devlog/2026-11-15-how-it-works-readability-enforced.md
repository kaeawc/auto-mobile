# Split over-length how-it-works pages and enforce their readability budget

- Kind: decision
- Date: 2026-11-15
- Source: #18145
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md), [iOS simulator prototype agent](../how-it-works/plat/ios/prototype-agent.md), [Prototype web renderer](../how-it-works/prototype-web-renderer.md)

## Context

The [per-section readability gate](2026-11-13-docs-readability-section-gate.md) left `how-it-works`
advisory. The report listed 1198 findings there: 932 long sentences, 145 long paragraphs, 106
passive-heavy paragraphs and 15 pages over the 2500-word page budget. The largest page, the
Android prototype specification, had 43494 prose words. Several design pages had grown by
appending one section per feature issue.

## Options

- Raise the `how-it-works` page budget until every page fits.
- Keep the long pages and exempt them by name.
- Split each over-length page into sibling pages along its existing sections, and rewrite long
  sentences and paragraphs in place.

## Decision

Each over-length page keeps its file name and becomes an overview that lists its sibling pages.
The sibling pages sit next to it as `<page>-<topic>.md`, so relative links inside moved sections
keep working. A moved section keeps its heading text, so its anchor stays the same, and links to
it now name the sibling page. Long sentences and paragraphs were split without dropping facts.
The `how-it-works` section is now `"enforced": true`.

## Consequences

A pull request that adds an over-budget sentence, paragraph or page under `docs/how-it-works/`
fails the `Docs Readability Report` job. A page that outgrows 2500 prose words gets a new sibling
page instead of a higher budget. Tests that read a specification page by path read the sibling
page that holds the asserted section; the worked-example test reads every `prototype-ux*.md` page.
