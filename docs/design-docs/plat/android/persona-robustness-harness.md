# Persona robustness harness

`scripts/persona-robustness/run.ts` is a research prototype (#14061). It replays one test plan
under a stock baseline and a matrix of device perturbations, and reports which perturbations
break the plan and why. It is a script over the public MCP surface, not a product tool.

## Matrix

| Kind       | Applied with                                  | Default set                                                     |
| ---------- | --------------------------------------------- | --------------------------------------------------------------- |
| `baseline` | `manufacturerProfile` `apply`                 | `pixel-baseline` (always runs first)                            |
| `persona`  | `manufacturerProfile` `apply`                 | every other catalog manufacturer profile                        |
| `display`  | `displayProfile` `apply`                      | `font-scale-1.3`, `density-larger`, `force-dark`, `cutout-tall` |
| `facet`    | `keyboard`, `killProfile` or `displayProfile` | one per facet of a failing persona, with `--ablate`             |

Fold posture is left out of the default display set because it needs a foldable AVD. Alias packs
join the matrix once #14056 has fixtures.

## Replay loop

1. Acquire one device session (`getAndroid`, or `--session`) and hold it for the whole run, so
   `executePlan` never releases it (#15333). The session enables the harness's tools
   (`manufacturerProfile`, `displayProfile`, `killProfile`, `keyboard`, `executePlan`), several
   of which are off by default.
2. `manufacturerProfile` `reset` once, so a previous run's changes do not leak in.
3. For each perturbation and repeat: apply, `executePlan`, then `manufacturerProfile` `reset`.
   That reset also undoes direct `displayProfile`, `keyboard` `setProfile` and `killProfile`
   changes, so one call restores every kind.
4. A failed reset stops the run: the device state is unknown and later replays would be
   misattributed. The report keeps the results so far and names the reason.

## Scoring

| Outcome     | Rule                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`      | `executePlan` succeeded with no skipped optional steps and no warnings                                                                                      |
| `recovered` | succeeded, but skipped optional steps or reported step warnings                                                                                             |
| `failed`    | `executePlan` failed; the report keeps `failedStep`                                                                                                         |
| `error`     | apply failed or reported a status other than `applied` (an unsupported overlay, a partial persona), or no plan result came back; says nothing about the app |

Repeats aggregate into a verdict: a single outcome is the verdict, pass with recovered is
`recovered`, any `error` is `error`, and failed mixed with success is `flaky`.

`recovered` reflects only the executor's own tolerance (optional steps, warnings). It does not
measure agent-driven recovery; that needs an agent in the loop, as in `scripts/agent-benchmark/`.

## Background survival matrix

The kill-profile survival harness (`scripts/kill-profile-survival/`) applies each kill profile on a
rootable emulator, advances the device clock and Doze, and scores eight fixture events as `ran`,
`delayed` or `never`. The expected scores live in `src/features/utility/KillProfileExpectedScores.ts`;
the harness requires API 33+.

| Profile                   | workmanager-periodic | workmanager-oneshot | jobscheduler | alarm-exact | alarm-inexact | foreground-service | boot-receiver | push-broadcast |
| ------------------------- | -------------------- | ------------------- | ------------ | ----------- | ------------- | ------------------ | ------------- | -------------- |
| samsung-sleeping          | ran                  | ran                 | delayed      | ran         | delayed       | ran                | ran           | ran            |
| samsung-deep-sleeping     | never                | never               | never        | never       | never         | never              | never         | never          |
| samsung-auto-disable      | never                | never               | never        | never       | never         | never              | never         | never          |
| xiaomi-autostart-off      | never                | never               | never        | never       | never         | never              | never         | never          |
| oneplus-deep-optimization | never                | never               | never        | never       | never         | never              | never         | never          |
| recents-swipe-kill        | ran                  | ran                 | delayed      | ran         | delayed       | ran                | ran           | ran            |
| recents-swipe-force-stop  | never                | never               | never        | never       | never         | never              | never         | never          |
| oneplus-sleep-standby     | ran                  | ran                 | delayed      | ran         | delayed       | ran                | ran           | ran            |
| motorola-adaptive         | ran                  | ran                 | delayed      | ran         | delayed       | ran                | ran           | ran            |
| user-restricted           | ran                  | ran                 | never        | ran         | never         | delayed            | ran           | ran            |
| exact-alarm-denied        | ran                  | delayed             | delayed      | never       | delayed       | never              | ran           | ran            |
| notifications-off         | ran                  | ran                 | delayed      | ran         | delayed       | ran                | ran           | ran            |

The measurements use an Android 15 (API 35) google_apis arm64 emulator. A real reboot is not
exercised; `BOOT_COMPLETED` is delivered by adb broadcast. The standby bucket `restricted` and
`SCHEDULE_EXACT_ALARM` deny did not read back on API 35 emulators, so scores of profiles that depend
on them reflect emulator behavior, not confirmed profile effects. `user-restricted`'s
workmanager-periodic is `ran` on API 35 and `never` on Android 14 (API 34), so OEM behavior is not
established by this table.

## Attribution

A perturbation that did not succeed is attributed against the baseline:

- When the baseline did not succeed, nothing is attributable.
- A display stressor or facet ablation changes one thing, so it is its own cause.
- A persona changes several facets. With `--ablate`, each facet that differs from the baseline
  replays alone; the facets that fail alone are the cause. A persona is reported as an
  interaction only when every facet replayed alone and passed; if none failed alone but a facet
  replay errored or never ran (an aborted run), the attribution is inconclusive. Without
  `--ablate`, the report lists the candidate facets.

Every persona facet's evidence status is printed with the report, so a simulated effect is never
read as behaviour measured on the OEM device.

## Limits

- The kill facet only acts when the app goes to the background. A plan that never leaves the app
  cannot fail because of it.
- One plan and one device per run. Comparing skins across plans means combining reports.
