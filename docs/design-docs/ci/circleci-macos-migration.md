# Moving GitHub-hosted macOS jobs to CircleCI (#10887)

Status: draft plan, 2026-10-08. The CircleCI mirrors of the always-hosted PR jobs
are in `.circleci/continue_config.yml` and run alongside the GitHub jobs. Nothing
on GitHub has been removed or re-gated yet.

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

I did not check which CircleCI plan the `kaeawc` organization is on, because that
needs a login.

### Xcode 26.5 / 26.6 images

Both exist and are current (not deprecated) on the
[Xcode image list](https://circleci.com/docs/guides/execution-managed/using-macos/#supported-xcode-versions):

| `xcode:` tag | Xcode build   | Image macOS      | iOS runtime | Manifest                                                                                |
| ------------ | ------------- | ---------------- | ----------- | --------------------------------------------------------------------------------------- |
| `26.5`       | 26.5 (17F42)  | 26.3.1 (25D2128) | iOS 26.5    | [v18380](https://circle-macos-docs.s3.amazonaws.com/image-manifest/v18380/manifest.txt) |
| `26.6`       | 26.6 (17F113) | 26.5.1 (25F80)   | iOS 26.5    | [v18807](https://circle-macos-docs.s3.amazonaws.com/image-manifest/v18807/manifest.txt) |

The `26.6` image ships the iOS **26.5** simulator runtime, not a 26.6 runtime.
Xcode 27.0, 27.1 and 27.2 images also exist. The existing `ios` executor already
runs on `xcode: "26.5"` + `m4pro.medium`. For example, PR #10815 received green
`ci/circleci: ios-swift-packages`, `ios-xcode-build`, `ios-playground-tests` and
`Prototype Simulator iOS 26` statuses from `circleci-app[bot]`.

### Does the allowance cover the load? No.

I measured GitHub-hosted macOS time from recent runs. The PR sample is the last
100 completed `pull_request.yml` runs, 2026-10-08 20:46Z to 2026-10-09 01:09Z
(about 4.4 h). The nightly sample is the last 15 `nightly.yml` runs.

| Lane                                                 | Runs in sample   | Mean min/run |
| ---------------------------------------------------- | ---------------- | ------------ |
| XCTestRunner Simulator Tests (before #10895)         | 20 / 100 PR runs | 21.6         |
| iOS Device Capture to WHEP                           | 5 / 100          | 10.0         |
| Swift Packages (Xcode 26.5)                          | 3 / 100          | 5.0          |
| Build Xcode Projects (Playground + CtrlProxy shards) | 3 / 100          | 2.3 + 1.0    |
| Build Root SPM Package                               | 3 / 100          | 1.3          |
| Nightly macOS total (10 jobs)                        | per night        | ≈ 34         |

- **PR load:** XCTestRunner Simulator Tests ran on PRs when this sample was taken.
  It now runs nightly and on PRs only with the `run-ios-sim` label (#10895), and it
  is not mirrored on CircleCI. The sample total was ≈ 510 hosted macOS minutes per
  100 PR runs (about 102,000 CircleCI credits, 3.4 months of the allowance). Without
  XCTestRunner (20 × 21.6 = 432 min) the remaining PR lanes are ≈ 78 min per 100 PR
  runs, which is about 15,600 credits, or about half a month of the open-source
  allowance, for about 4.4 h of campaign-pace traffic.
- **Nightly load:** ≈ 34 min/night, plus about 1.5 min of VM start per job, ≈ 49
  min. That is ≈ 9,800 credits/night, or ≈ 294,000 credits/month, which is 10× the
  allowance. At the overage price that is about $176/month for nightly alone.
- **Concurrency:** before #10895 the 20 XCTestRunner runs alone were 432
  job-minutes in 264 wall-clock minutes, which needs at least 2 macOS jobs running
  at all times. With XCTestRunner off the PR path, the mirrored lanes are short
  (about 78 job-minutes per 264 wall-clock minutes), so a concurrency of 1–2 is
  workable for them. Today GitHub gives 5.

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
on PRs only with the `run-ios-sim` label (#10895). The required contexts
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

## 3. Migration table

Estimates: CircleCI minutes = GitHub mean + ~1.5 min VM start, or a guess where
there is no hosted sample. Credits = minutes × 200 (`m4pro.medium`).

| GitHub job (workflow)                                                                                      | Today                                       | CircleCI job                                           | Class        | Est. min/run                                | Est. credits/run  | Secrets                                                                                           | Move?                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ | ------------ | ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| XCTestRunner Simulator Tests (nightly + `run-ios-sim` label, #10895)                                       | hosted `macos-26`                           | none (not mirrored on PRs)                             | —            | ~24                                         | 0 on CircleCI     | none                                                                                              | No; stays on GitHub, off the PR path                          |
| iOS Device Capture to WHEP (PR, advisory)                                                                  | hosted `macos-26`                           | `ios-device-webrtc` (added)                            | m4pro.medium | ~12                                         | ~2,400            | none                                                                                              | Paid plan; ScreenCaptureKit on CircleCI VMs is not yet proven |
| Build Root SPM Package (PR, **required**)                                                                  | hosted `macos-26`                           | `ios-spm-root-package-build` (added)                   | m4pro.medium | ~3                                          | ~600              | none                                                                                              | Yes, behind the §2 shim                                       |
| Swift Packages (PR → **iOS Build**)                                                                        | hosted `macos-26`                           | `ios-swift-packages` (existing; API check added)       | m4pro.medium | ~7                                          | ~1,400            | none (signing pinned off)                                                                         | Yes, behind the shim                                          |
| Build Xcode Projects ×2 shards (PR → **iOS Build**)                                                        | hosted `macos-26`                           | `ios-xcode-build` (existing, one job)                  | m4pro.medium | ~5                                          | ~1,000            | none                                                                                              | Yes, behind the shim                                          |
| iOS Playground Tests (PR, advisory)                                                                        | CircleCI; GitHub only for label-forced runs | `ios-playground-tests` (existing)                      | m4pro.medium | ~6                                          | ~1,200            | none                                                                                              | Already moved                                                 |
| SwiftLint (PR, **required**; hosted only for forks)                                                        | self-hosted / fork → `macos-26`             | not added (phase 2)                                    | m4pro.medium | ~3                                          | ~600              | none                                                                                              | Fork leg only; same-repo stays self-hosted                    |
| Swift Code Coverage (PR, **required**; hosted only for forks)                                              | self-hosted / fork → `macos-26`             | `swift-code-coverage` (exists for main)                | m4pro.medium | ~4                                          | ~800              | none                                                                                              | Fork leg only                                                 |
| Build Desktop App (macos leg; fork fallback)                                                               | self-hosted / fork → `macos-latest`         | not added                                              | m4pro.medium | ~6                                          | ~1,200            | none                                                                                              | Fork leg only, low priority                                   |
| Installer Minimal (macos-latest) (PR, **required**; fork fallback)                                         | self-hosted / fork → `macos-latest`         | not added                                              | m4pro.medium | ~2                                          | ~400              | none                                                                                              | Fork leg only, behind a shim                                  |
| Merge: Build Desktop App, Generate/Build Xcode Projects                                                    | dormant (`if: false`, #8583)                | none                                                   | —            | 0                                           | 0                 | —                                                                                                 | Nothing to move; coverage already runs on CircleCI post-merge |
| Nightly: Swift Packages / Build Xcode Projects sweeps (26.5, 26.6)                                         | hosted `macos-26`                           | new nightly workflow, `xcode: 26.5` / `26.6` executors | m4pro.medium | ~6 + ~6 + ~4 + ~4                           | ~4,000            | none                                                                                              | Paid plan; scheduled pipeline on main                         |
| Nightly: XCTestRunner Thread Sanitizer                                                                     | hosted `macos-26`                           | nightly                                                | m4pro.medium | ~3                                          | ~600              | none                                                                                              | Paid plan                                                     |
| Nightly: macOS BATS / BATS integration / Node unit / Node host integration                                 | hosted `macos-latest`                       | nightly                                                | m4pro.medium | ~8 + ~2 + ~10 + ~4                          | ~4,800            | none                                                                                              | Paid plan; no Xcode needed                                    |
| Nightly + release: Build CtrlProxy iOS IPA                                                                 | hosted `macos-26`                           | —                                                      | —            | ~3                                          | ~600              | none (unsigned)                                                                                   | Could move; no secrets                                        |
| Release: build-overlay-agent (ad-hoc signed)                                                               | hosted `macos-26`                           | —                                                      | —            | ~3                                          | ~600              | none                                                                                              | Could move; no secrets                                        |
| Release: build-screen-capture-helper, build-network-filter-probe, build-desktop-app-installers (macOS DMG) | hosted `macos-26` / `macos-latest`          | —                                                      | —            | ~10–25 each (notarization waits are billed) | ~2,000–5,000 each | Developer ID cert + password, keychain password, App Store Connect API key, provisioning profiles | **Do not move** (below)                                       |

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

## Validation of this draft

- The `circleci` CLI is not installed on the authoring machine, so
  `circleci config validate` was not run. Policy tests and a YAML structure check
  (every job, command, executor and pipeline parameter resolves) passed, and
  every `run` body passes shellcheck.
- `test/scripts/circleciMacosMigrationPolicy.test.ts` checks four things. The
  `run-webrtc` mapping must equal the glob-for-glob translation of the GitHub
  filter, and no `run-ios-integration` parameter or XCTestRunner job may exist
  (#10895). The mirrors must keep their GitHub names.
  No workflow may use a context. The executor must pin signing off.
