# Moving GitHub-hosted macOS jobs to CircleCI (#10887)

Status: superseded 2026-10-09 by the [macOS CI capacity plan](macos-capacity-plan.md)
(#11010, #11011, #11012). CircleCI now carries one PR job (Playground) plus all
post-merge and nightly macOS work, and the PR mirrors described below were
removed. The plan numbers and the release/signing analysis below still apply.

## 1. CircleCI's macOS allowance (checked 2026-10-08)

| Fact                                       | Value                                                                                          | Source                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open-source macOS credits                  | "Organizations on our Free Plan 30,000 credits every month to use on macOS open source builds" | [Using credits: open source credit usage](https://circleci.com/docs/guides/plans-pricing/credits/)                                                                |
| Open-source macOS concurrency              | "a maximum of 2 concurrent jobs per organization"                                              | same page                                                                                                                                                         |
| Free-plan macOS concurrency (pricing page) | 1 concurrent macOS job run (Performance: 15)                                                   | [Pricing](https://circleci.com/pricing/)                                                                                                                          |
| Free-plan macOS resource class             | Only M4 Pro Medium; the default since 2025-11-10                                               | [Pricing](https://circleci.com/pricing/), [changelog](https://circleci.com/changelog/free-plan-default-macos-resource-class-changes-to-m4pro-medium-on-november/) |
| `m4pro.medium`                             | 6 vCPU, 28 GB, **200 credits/min**                                                             | [Price list](https://circleci.com/pricing/price-list/)                                                                                                            |
| `m4pro.large`                              | 12 vCPU, 56 GB, 400 credits/min (not on Free)                                                  | same                                                                                                                                                              |
| Credit price beyond the allowance          | "$15 for every additional 25,000 credits" (≈ $0.0006/credit, so ≈ $0.12/min on `m4pro.medium`) | [Pricing](https://circleci.com/pricing/)                                                                                                                          |
| m1/m2 classes                              | Deprecated 2026-02-16; configs naming them fail to parse                                       | [changelog](https://circleci.com/changelog/free-plan-default-macos-resource-class-changes-to-m4pro-medium-on-november/)                                           |

The Free-plan macOS allowance is **30,000 credits ≈ 150 `m4pro.medium` minutes
per month**, with 1 concurrent macOS job (the pricing page) or 2 (the open-source
credits page). The two CircleCI pages disagree. Check the organization's plan page
for the real number. For comparison, GitHub-hosted runners allow 5 concurrent macOS
jobs on GitHub Free ([Actions limits](https://docs.github.com/en/actions/reference/limits)),
and standard runners are free for public repositories.

The `kaeawc` organization's actual CircleCI plan was not checked (needs a login).

The `xcode: "26.5"` and `"26.6"` images exist and are current; `26.6` ships the iOS **26.5**
simulator runtime, not a 26.6 one. The `ios` executor runs on `xcode: "26.5"` + `m4pro.medium`.

### Does the allowance cover the load? No.

Measured from 100 PR runs (2026-10-08/09, ~4.4 h) and 15 nightly runs:

- **PR load:** XCTestRunner Simulator Tests (21.6 min/run, 20 of 100 runs) dominated at ≈ 510
  hosted macOS minutes per 100 PR runs (≈ 102,000 credits, 3.4 months of allowance). It now runs
  nightly, on `run-ios-sim` PRs (#10895) and on PRs that touch an iOS SDK contract input, and is
  not mirrored on CircleCI. The remaining PR lanes (device capture ~10, Swift Packages ~5, Xcode builds ~3.3, root SPM ~1.3 min/run) are
  ≈ 78 min per 100 PR runs ≈ 15,600 credits.
- **Nightly load:** ≈ 34 min/night plus ~1.5 min VM start per job ≈ 49 min ≈ 9,800 credits/night
  ≈ 294,000 credits/month, 10× the allowance (≈ $176/month at overage price).
- **Concurrency:** with XCTestRunner off the PR path, the mirrored lanes need 1–2 concurrent
  macOS jobs; GitHub gives 5.

**Conclusion:** the Free/open-source plan cannot carry the PR and nightly macOS
load. Moving everything would replace free, 5-wide GitHub macOS capacity with
1–2-wide paid capacity. A full move only makes sense on a paid plan
(Performance: 15 concurrent macOS jobs). Even a tenth of the measured PR pace
(≈ 280 min/day) works out to about 1.7 M credits/month, roughly $1,000/month at
$15/25k credits. Options, in order of cost:

1. Keep CircleCI as overflow for short, path-filtered build lanes (today's
   setup). XCTestRunner Simulator Tests stays on GitHub (nightly / `run-ios-sim`
   label, #10895) and is not mirrored on PRs; CircleCI uses the organization's
   existing plan.
2. Buy a paid plan and move PR lanes in the order of the table in §3, judged by
   one week of credit burn.
3. Move only nightly, on a paid plan. It is the most predictable load (≈ 49
   min/night).

## 2. Required-check continuity

### How CircleCI reports

CircleCI posts **commit statuses**, not check runs, with the context
`ci/circleci: <job name>`, where `<job name>` is the workflow invocation's `name:`
(or the job key). On this repository they are created by `circleci-app[bot]`,
the CircleCI GitHub App (app id **302869**, slug `circleci-app`). The mirrors
added for #10887 use `name:` values identical to the GitHub jobs, so they report
as `ci/circleci: Build Root SPM Package` and `ci/circleci: iOS Device Capture to
WHEP`. XCTestRunner Simulator Tests has no PR mirror: GitHub runs it nightly and
on PRs with the `run-ios-sim` label (#10895) or an iOS SDK contract input change. The required contexts
in the `green-main` ruleset (id 11406121) are bare names (`SwiftLint`, `Swift
Code Coverage`, `Build Root SPM Package`, `iOS Build`, `Installer Minimal
(macos-latest)`, …), all pinned to integration **15368** (GitHub Actions). A
CircleCI status can never satisfy them as they stand.

### Option A: change the ruleset to require `ci/circleci: …`

Replace, for example, `Build Root SPM Package` (15368) with
`ci/circleci: Build Root SPM Package` (integration 302869). **This does not work
on its own.** CircleCI posts nothing when path filtering skips the workflow, so
on every non-iOS, docs-only or auto-chore PR the required context stays
"Expected — Waiting for status" and blocks the merge. Rulesets cannot mark a
missing status as skipped. Making it work would mean running every macOS lane
on every PR, which the credit numbers above rule out.

### Option B (recommended): GitHub Actions shim gates under the existing names

Each required name stays a GitHub Actions job (integration 15368, so the
ruleset is unchanged). The job runs on Ubuntu and waits for the matching
CircleCI status. This follows the pattern of the existing `iOS Build` roll-up:

```yaml
ios-spm-root-package-build: # replaces the macos-26 job body
  name: "Build Root SPM Package" # unchanged required name
  runs-on: ubuntu-latest
  timeout-minutes: 90 # CircleCI queue + 20 min job
  needs: [detect-changes]
  permissions:
    statuses: read
  steps:
    - name: "Wait for ci/circleci: Build Root SPM Package"
      if: needs.detect-changes.outputs.ios_changed == 'true'
      env:
        GH_TOKEN: ${{ github.token }}
        SHA: ${{ github.event.pull_request.head.sha }}
        CONTEXT: "ci/circleci: Build Root SPM Package"
      run: |
        while :; do
          state="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${SHA}/statuses?per_page=100" |
            jq -r --arg c "${CONTEXT}" \
              '[.[] | select(.context == $c and .creator.login == "circleci-app[bot]")][0].state // "missing"')"
          case "${state}" in
            success) exit 0 ;;
            failure|error) echo "::error::${CONTEXT} is ${state}"; exit 1 ;;
          esac
          sleep 30
        done
```

The shim rules:

- **Filter on creator.** Count only statuses from `circleci-app[bot]`, so no
  other token can satisfy the gate by posting the context.
- **Gate on the path-only output**, `ios_changed` (and the WebRTC path output), never on `ios_should_run`. CircleCI cannot see the
  `run-ios` / `run-native` labels or the WebRTC title/body opt-in. For a
  label-forced run whose paths did not change, keep running the GitHub job
  itself, as `ios-playground-tests` already does. Otherwise the shim would wait
  for a status that never comes.
- **Forks:** the shim reads statuses with the read-only `GITHUB_TOKEN`, so it
  needs no secret and works on fork PRs. CircleCI must build forked PRs (see §4).
- **`iOS Build`** keeps its roll-up form and waits on
  `ci/circleci: ios-swift-packages` and `ci/circleci: ios-xcode-build`. The
  CircleCI Swift Packages job now runs the API-baseline check that this gate
  enforces on GitHub.
- **Cost:** shim minutes are Ubuntu minutes, which are free on a public repo,
  and `namespace-profile-auto-mobile-small` covers same-repo PRs.
- **Advisory lanes** (`iOS Device Capture to WHEP`, `iOS Playground Tests`,
  `Prototype Simulator`) are not required and need
  no shim. Remove their GitHub jobs once the CircleCI ones have been green for a
  week.

Option B needs no ruleset edit. If a required name ever changes, update the
`green-main` ruleset in the same PR, as issue #10887 step 3 says.

## 3. Migration table (summary)

Estimates: CircleCI minutes = GitHub mean + ~1.5 min VM start; credits = minutes × 200
(`m4pro.medium`). No PR lane needs secrets.

| Job                                                                                                        | CircleCI job                             | Est. min/run                | Disposition                                               |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------- | --------------------------------------------------------- |
| XCTestRunner Simulator Tests (nightly + `run-ios-sim`)                                                     | none                                     | ~24                         | Stays on GitHub, off the PR path                          |
| iOS Device Capture to WHEP (advisory)                                                                      | `ios-device-webrtc`                      | ~12                         | Paid plan; ScreenCaptureKit on CircleCI VMs unproven      |
| Build Root SPM Package (**required**)                                                                      | `ios-spm-root-package-build`             | ~3                          | Yes, behind the §2 shim                                   |
| Swift Packages / Build Xcode Projects (→ **iOS Build**)                                                    | `ios-swift-packages` / `ios-xcode-build` | ~7 / ~5                     | Yes, behind the shim                                      |
| iOS Playground Tests (advisory)                                                                            | `ios-playground-tests`                   | ~6                          | Already moved                                             |
| SwiftLint, Swift Code Coverage, Build Desktop App, Installer Minimal (**required**; hosted only for forks) | none / `swift-code-coverage` (main)      | 2-6                         | Fork leg only, behind a shim; same-repo stays self-hosted |
| Nightly sweeps (Swift Packages/Xcode 26.5+26.6, TSan, macOS BATS/Node)                                     | new nightly workflow                     | ~6-10 each                  | Paid plan; scheduled pipeline on main                     |
| Release: CtrlProxy IPA, prototype-agent (unsigned/ad-hoc)                                                  | none                                     | ~3                          | Could move; no secrets                                    |
| Release: screen-capture helper, network-filter probe, desktop DMG installers                               | none                                     | 10-25 (notarization billed) | **Do not move** (below)                                   |

**Release/signing should stay on GitHub.** Releases are rare and are not limited
by concurrency, so moving them gains nothing. Moving them would copy the Developer
ID certificate, keychain password and App Store Connect key into a second vendor,
which means two places to rotate and audit. If they ever move, use one context,
for example `automobile-apple-signing`, with all three restriction types: a
security group (a team containing only the owner), a project restriction (this
project only), and an expression restriction such as
`pipeline.git.branch == "main" or pipeline.git.tag starts-with "v"`. The context
must be attached only in workflows whose jobs carry `filters: { branches: { only:
main } }` / tag filters. CircleCI fails the workflow as `Unauthorized` when a
restriction does not match
([Contexts](https://circleci.com/docs/guides/security/contexts/)).
`test/scripts/circleciMacosMigrationPolicy.test.ts` currently fails if any CircleCI
workflow names a context. Relax it only for that main/tag-filtered workflow.

## 4. Owner steps in the CircleCI UI

The project is already connected: every PR gets `ci/circleci: detect-ios-changes`
from `circleci-app[bot]`. The remaining steps are all in the CircleCI web app.

1. **Organization Settings → Plan:** note the plan and the macOS concurrency it
   shows. If it says Free, decide between §1 options 1–3 before turning on any
   gate.
2. **Project Settings → Advanced:**
   - "Enable dynamic config using setup workflows": confirm it is **On**. It is
     already required by `.circleci/config.yml`.
   - "Build forked pull requests": **On**, so fork PRs get the statuses the shims
     wait for.
   - "Pass secrets to builds from forked pull requests": **Off**, which is the
     default ([open source docs](https://circleci.com/docs/guides/integration/oss/)).
   - "Only build pull requests": **On**, so branch pushes without a PR do not
     spend macOS credits. Main is already excluded by the setup workflow.
3. **Project Settings → Environment Variables:** keep this empty. The PR lanes
   need no secrets, and the executor pins signing off anyway.
4. **Organization Settings → Contexts:** create none for this phase. Create the
   restricted signing context only if release jobs ever move (§3).
5. **Project Settings → Triggers / Schedules:** add a nightly schedule only after
   choosing a paid plan (§1 option 2 or 3).
6. Watch one week of `ci/circleci: Build Root SPM Package` and
   `iOS Device Capture to WHEP` results and credit
   burn on the **Plan → Usage** page. Then land the §2 shims and remove the
   matching GitHub macOS jobs in the same PR (issue #10887 step 6).

## Validation

`test/scripts/circleciMacosMigrationPolicy.test.ts` checks that the `run-webrtc` mapping equals
the glob-for-glob translation of the GitHub filter, that no `run-ios-integration` parameter or
XCTestRunner job exists (#10895), that the mirrors keep their GitHub names, that no workflow uses
a context, and that the executor pins signing off.
