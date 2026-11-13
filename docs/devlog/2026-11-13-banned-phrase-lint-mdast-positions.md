# Banned-phrase lint takes source lines from mdast positions

- Kind: decision
- Date: 2026-11-13
- Source: #18196 (follow-up to #18186, #18189 and #18191)

Dependency: `mdast-util-from-markdown`
Dependency: `mdast-util-gfm-table`
Dependency: `micromark-extension-gfm-table`
Dependency: `mdast-util-gfm-strikethrough`
Dependency: `micromark-extension-gfm-strikethrough`

## Context

`scripts/docs/bannedPhrases.ts` parsed docs with `Bun.markdown` (md4c), which emits rendered text
without source offsets. Each text leaf was mapped back to its line by a hand-written forward
scanner that blanked link reference definitions and skipped inline link syntax. Every review round
found more Markdown it misread. It mishandled quotes inside a parenthesized link title, multi-line
definitions, full reference-link labels and an escaped `>` in an angle-bracket destination (#18189).
Its definition span checks that went quadratic on 600 definition-like lines in a code block (#18191).

## Options

- Keep `Bun.markdown` and extend the scanner. Each fix re-implements part of CommonMark link and
  definition parsing, which is the class of bug being fixed.
- `Bun.markdown` exposes only `html`, `ansi`, `render` and `react`; none of its renderer callbacks
  carries a source position, so the runtime parser cannot give positions directly.
- No Markdown parser with positions was installed (checked `package.json`, `bun.lock`, `src/` and
  `scripts/lib/`).
- `mdast-util-from-markdown` (micromark): a CommonMark parser whose every node has a start and end
  position. GFM tables and strikethrough need their `micromark-extension-gfm-*` and `mdast-util-gfm-*`
  packages.

## Decision

Parse with `mdast-util-from-markdown` plus the GFM table and strikethrough extensions,
all as dev dependencies used
only by `scripts/docs/`. Text nodes keep soft line breaks as newlines, so each character's line is
the node's start line plus the newlines before it. Definitions, link destinations, titles and
reference labels are never text nodes, so the hand scanner is deleted.

## Consequences

Line numbers are unchanged on the docs tree as of this change, including a dense common-word rule
set. Parsing the whole docs tree takes about 2 s in micromark, against about 0.3 s in md4c; the
600-line case that took minutes now takes milliseconds.
