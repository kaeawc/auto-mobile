<!--
Keep PRs focused: one feature or fix per PR (see .github/CONTRIBUTING.md).
Delete sections that do not apply.
-->

## Summary

<!-- What changed and why, in a short paragraph. -->

## Linked Issue

<!-- Reference the issue this PR addresses. Use "Closes #N" to auto-close on merge. -->

Closes #

## Bug / Regression Context

<!-- Fill in for bug fixes and regressions; delete for pure features. -->

- **Prior attempts:** <!-- e.g. an earlier PR that merged but did not fix it -->
- **Observed symptom:** <!-- what was actually failing -->
- **Repro steps / conditions:** <!-- the sequence that triggers it -->

## Validation

<!-- Almost everything in CI runs locally; see the scripts/ directory. -->

- [ ] `scripts/all_fast_validate_checks.sh` passes (`bun run lint` + `bun test`)
- [ ] `bun run typecheck` reports no new errors (baseline gate)
- [ ] Android/iOS changes: ran the matching `scripts/` validation
- [ ] New code uses interfaces + fakes + FakeTimer; unit tests run in <100ms
- [ ] New generic code reuses the standard library or an existing project helper; any new direct dependency has a decision record under `docs/decisions/`
- [ ] Rebased onto latest `main`, conflicts resolved

## Kotlin Reuse Check

<!-- Delete when this PR does not modify Kotlin. -->

- [ ] Checked Kotlin stdlib/JDK/AndroidX, existing module dependencies, and dependency-compatible AutoMobile modules before adding helpers, wrappers, `*Util` files, or dependencies
- [ ] Any intentional custom implementation or new dependency exception is explained in the summary

## Device Verification

<!-- For changes that affect on-device behavior (observe, gestures, hierarchy, tools). Delete if N/A. -->

- [ ] Verified on a real Android device / iOS simulator via `observe`
- [ ] Screenshots or before/after attached

## Follow-ups

<!-- Out-of-scope gaps kept separate to keep this PR focused. -->

- [ ] Follow-up issues filed for gaps not addressed here: #
