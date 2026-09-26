# Observe resolution migration contract (S0)

`observeContract.test.ts` discovers every JSON fixture under `test/fixtures/observe`,
including nested diff captures and both raw notification states. It collects and
projects each capture through production observe code, then resolves every emitted
ID, label and test tag through the legacy finder/selector and real S2 resolver.
Assertions compare chosen bounds to the displayed row. Duplicate labels receive
an explicit index in display order; S2 uses each row's advertised action. The
legacy text reference uses the public tap path's partial-match and tap-intent
options, including normalized whitespace labels. `publicTextCases` separately
preserves unique unindexed text queries; a focused behavior probe pins actual
legacy outcomes for the five duplicate-label groups, including the two Settings
child targets. S2 tests the corrected unindexed displayed-parent policy. These
probes are not additional roundtrip exemptions and do not expand the frozen
seed. The trim-only fixture has no actionable rows; its zero selector
count is pinned. The synthetic `<ime>` keyboard mode summary is not a selector.

`observeContractGaps.json` records individual failing cases, keyed by original
finding ID. The original baseline covered B7 (node key versus native ID),
B1 (hoisted label versus descendant bounds), and C-index-3 (displayed row index
versus text candidate index); only two B1 cases remain. Keys include the fixture, selector and
expected bounds, so an exception cannot silently cover a different target. Follow
the repository's per-occurrence ratchet convention: entries may only be removed,
never broadened or added. The lint/Fast Validation gate compares finding-and-case
keys against the merge-base baseline; same-count replacements and moving an
exception to another finding fail. The inception baseline is digest-pinned when
the base predates this contract, and missing merge history fails closed. An
improvement fails until its stale exemption is removed; an unknown failure also fails. Fixture coverage counts prevent silent
loss of selectors. Deliberate fixture replacements require reviewing this contract.

`resolverContract.test.ts` runs all 174 queries against both the legacy
finder/selector and the real S2 resolver. The independent candidate oracle is
the ordered identities actually projected by observe. Both Settings text-input
captures additionally pin the keyboard Settings button's captured ID and bounds;
these two B1 roundtrip exceptions remain because the smaller keyboard control
is still selected. The list shrank from 103 cases to two.

Every new ordered candidate list must equal that oracle, including known-gap
cases. Strict legacy equality is required when the differential reports no
change. A changed result must correct a legacy candidate-list mismatch against
the oracle; a chosen-only match cannot hide added, missing, reordered or wrong
identity candidates. The chosen target separately round-trips in the companion
contract test. The adapter preserves each explicit index rather than compensating
for resolver filtering.

Run: `bun test test/features/element-resolution/`.
