# Docs readability gate per section

- Kind: decision
- Date: 2026-11-13
- Source: #18145 (follow-up to #18154)

## Context

#18154 added `scripts/docs/check-readability.ts` as an advisory report. It checks each docs page
against the budgets of its section in `scripts/docs/readability-budgets.json`. The issue asks for
the check to become required once main meets the budgets. On main the report listed 1753
findings: 385 in `using`, 1159 in `how-it-works` and 209 in `devlog`. One pull request cannot
clear all of them. A single all-or-nothing `--strict` switch would keep every section advisory
until the last one is clean, so a cleaned section could regress in the meantime.

Eight devlog pages were over the 1200-word page budget, the largest at 2940 words. These are
design records whose options and consequences sections carry the content. Cutting them to 1200
words would mean dropping recorded history or splitting one decision across entries.

## Options

- Keep one global `--strict` switch and flip it when every section is clean.
- Add a per-section `enforced` flag, so each section becomes a gate as soon as it is clean.
- Keep a per-file baseline of finding counts and fail only on growth.

## Decision

Each section in the budgets file takes an optional `enforced` flag, which defaults to false.
Findings in an enforced section fail the check and appear as error annotations. Findings in other
sections stay warnings. `--strict` still fails on any finding.

The devlog page budget rises from 1200 to 3000 words. The devlog prose was rewritten to meet the
sentence, paragraph and passive-voice budgets, and `devlog` is the first enforced section.

## Consequences

A pull request that adds a devlog entry with an over-budget sentence or paragraph fails the
`Docs Readability Report` job. `using` and `how-it-works` stay advisory until their findings
reach zero; each then gets `"enforced": true`. The job is not in the `green-main` ruleset yet;
adding it there is a repository setting, not a code change.
