# Observe resolution contract (S0)

`observeContract.test.ts` discovers every JSON fixture under `test/fixtures/observe`,
including nested diff captures and both raw notification states. It collects and
projects each capture through production observe code, then resolves every emitted
ID, label and test tag through the real S2 resolver. Assertions compare chosen
bounds to the displayed row. Duplicate labels receive an explicit index in display
order; S2 uses each row's advertised action. `publicTextCases` separately preserves
unique unindexed text queries. The trim-only fixture has no actionable rows; its
zero selector count is pinned. The synthetic `<ime>` keyboard mode summary is not
a selector. The legacy finder reference side was retired with `ElementFinder`
(#10271).

`observeContractCaseKeys.json` pins every generated selector query and observed
bounds. The lint/Fast Validation ratchet compares it with the merge-base version:
new cases may be added, but an existing obligation cannot silently disappear or
be replaced by a same-count case. Its first reviewed snapshot is digest-pinned.

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

`observeContractGapSignatures.json` records the wrong target each remaining gap
resolves to, so a gap cannot drift to a different wrong target; the contract test
reads only the entries for surviving gaps. Its other entries are the retired legacy
finder's targets (#10271), kept because `test/scripts/elementResolutionRatchet.test.ts`
reads this file as ratchet input.

`resolverContract.test.ts` runs every query against the real S2 resolver. The
independent candidate oracle is the ordered identities actually projected by
observe. Both Settings text-input captures additionally pin the keyboard Settings
button's captured ID and bounds; these two B1 roundtrip exceptions remain because
the smaller keyboard control is still selected. Every ordered candidate list must
equal that oracle, including known-gap cases. The chosen target separately
round-trips in the companion contract test. The adapter preserves each explicit
index rather than compensating for resolver filtering.

Run: `bun test test/features/element-resolution/`.
