# Observe resolution migration contract (S0)

`observeContract.test.ts` discovers every JSON fixture under `test/fixtures/observe`,
including nested diff captures and both raw notification states. It collects and
projects each capture through production observe code, then resolves every emitted
ID, label and test tag through the legacy finder/selector. Assertions compare the
chosen bounds to the displayed row. Duplicate labels receive an explicit index
in display order. The legacy text reference uses the public tap path's partial-match and tap-intent options, including normalized whitespace labels. `publicTextCases` separately preserves unique unindexed text queries; a focused behavior probe pins actual legacy outcomes for the five duplicate-label groups, including the two Settings child targets. S2 tests the corrected unindexed displayed-parent policy. These probes are not additional roundtrip exemptions and do not expand the frozen seed. The trim-only fixture has no actionable rows; its zero selector
count is pinned. The synthetic `<ime>` keyboard mode summary is not a selector.

`observeContractCaseKeys.json` pins every generated selector query and observed
bounds. The lint/Fast Validation ratchet compares it with the merge-base version:
new cases may be added, but an existing obligation cannot silently disappear or
be replaced by a same-count case. Its first reviewed snapshot is digest-pinned.

`observeContractGaps.json` records individual failing cases, keyed by original
finding ID: B7 (node key versus native ID, including historical UUID/view-id
fixtures), B1 (hoisted label versus descendant bounds), and C-index-3 (displayed
row index versus text candidate index). Keys include the fixture, selector and
expected bounds, so an exception cannot silently cover a different target. Follow
the repository's per-occurrence ratchet convention: entries may only be removed,
never broadened or added. The lint/Fast Validation gate compares finding-and-case
keys against the merge-base baseline; same-count replacements and moving an
exception to another finding fail. The inception baseline is digest-pinned when
the base predates this contract, and missing merge history fails closed. An improvement fails until its stale exemption is
removed; an unknown failure also fails. Fixture coverage counts prevent silent
loss of selectors. Deliberate fixture replacements require reviewing this contract.

S0 is **not complete yet**. `ContractResolver` is the adapter seam for S2's real
resolver. `compareResolvers` compares chosen identity and ordered candidate
identities (native ID, node key, bounds, text, label, value, class and test tag). Its current tests inject broken results
to prove mismatch detection; they do not claim legacy-versus-legacy equivalence
is evidence for a new resolver. S2 must wire its actual resolver into this seam,
run the full fixture matrix differentially, and record only owner-approved
finding-specific semantic differences before closing S0.

Run: `bun test test/features/element-resolution/observeContract.test.ts`.
