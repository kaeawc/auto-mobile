# Prototype performance measurement

## Compose compiler reports

From the repository root, run:

```bash
scripts/android/compose-compiler-report.sh
```

The script compiles `:control-proxy:compileReleaseKotlin --rerun` with
`-Pautomobile.composeCompilerReports=true`. Only the exact property value `true`
enables compiler reports and metrics; normal builds do not configure their
output destinations. The rerun forces compiler execution even with cached outputs.
The reports land in the `compose-compiler-reports` directory of the control-proxy
module's Gradle build output: `control-proxy-composables.txt` is at its root and the
module metrics are in `release/control-proxy-module.json`. The property alone does not
force a recompile, so an up-to-date or cached compile writes nothing.

To summarize existing reports without Gradle, use `--reports-dir DIR`. Use
`--package PREFIX` to select fully qualified function names starting with
`PREFIX.` (default: `dev.jasonpearson.automobile.ctrlproxy.prototype`). Use
`--write-doc docs/design-docs/plat/android/prototype-compose-compiler-report.md`
to overwrite the [generated Compose compiler report](prototype-compose-compiler-report.md)
page; stdout still contains the same deterministic summary.

The totals count listed functions, including value-returning helpers and overloads.
The table sorts simple function names, preserving report order for overloads.
Restartable means Compose can independently restart the function; skippable means
it can skip a call when its arguments have not changed. Unstable parameters list
explicit `unstable` markers; the final column lists parameters with no compiler
stability marker. Stable parameters are omitted, and `—` means none. Default-value
annotations are removed. The module-wide line reports counts for the entire module,
not just the selected package.

With strong skipping on (`featureFlags.StrongSkipping = true`), every restartable
composable is skippable, so the useful signal is the unstable and unmarked parameters,
which are compared by instance identity rather than `equals` when unstable at runtime.
The captured module aggregate has different totals from this package listing;
compare the same report scope across measurements.

## Frame-time benchmark

Prerequisites: a connected Android device explicitly selected by ID, a compatible
CtrlProxy with its accessibility service enabled, `adb`, `bun`, `jq`, and an already
running AutoMobile daemon. The script never starts or configures a daemon. If the
device belongs to a session, export its `AUTOMOBILE_SESSION_UUID`; the script passes
it as `--session-uuid` on every CLI call. Measure a release-like build; debug numbers
are only comparable with debug numbers (see #12129).

```bash
scripts/android/prototype-frame-benchmark.sh --device DEVICE_ID
scripts/android/prototype-frame-benchmark.sh --list
scripts/android/prototype-frame-benchmark.sh --dry-run --device DEVICE_ID
scripts/android/prototype-frame-benchmark.sh --device DEVICE_ID --scenario tab-switch --markdown
```

The fixed fullscreen spec is `benchmark/prototype-frame/spec.json`, ID
`perf-benchmark`. It expands to approximately 900 mapped nodes, including hidden
subtrees, 150 list rows, 30 images, four state-selected tab bodies, four pager pages,
and more than 70 visibility conditions. Individual repeats stay within the 128-item
contract limit. The pager, controls, tab body, and collapsing section have bounded
regions so the long list can scroll without moving the scenario controls offscreen.

The image contract requires asset IDs. The 30 nodes reference `benchmark-image`;
missing assets render placeholders. The owed asset step is to upload a representative
PNG/JPEG/WebP as `benchmark-image` through `prototype`'s `assets` argument before
recording an image-decoding baseline. The default script measures placeholders and
must be labelled that way; it does not push assets.

`benchmark/prototype-frame/scenarios.json` is the single source of truth. Each entry
has `name`, `description`, `repeat`, `settleMs`, and `steps`; idle additionally has
`durationMs`. Each step has `tool` and `text`; swipes additionally have `direction`.
The script converts text to a tap `selector` or swipe `container` and explicitly
uses `layer: prototype`. It sleeps after each complete repetition, or for idle's
specified duration. Other steps have no extra sleep between commands.

| Scenario         | Repeats | Steps per repeat                                       | Settle           |
| ---------------- | ------- | ------------------------------------------------------ | ---------------- |
| idle             | 1       | No input; count frames rendered in 3 seconds           | 3000 ms duration |
| tab-switch       | 5       | Tab 2, Tab 3, Tab 4, Tab 1                             | 600 ms           |
| section-collapse | 4       | Toggle section twice (collapse, reopen)                | 600 ms           |
| pager-swipe      | 4       | Swipe Benchmark pager left, right                      | 600 ms           |
| scroll           | 4       | Swipe Benchmark list up, down                          | 600 ms           |
| overlay-open     | 1       | Open overlay, Close overlay                            | 600 ms           |
| three-write-tap  | 5       | three-write tap (three independent counter increments) | 600 ms           |

The script shows the spec once and waits `--show-settle-ms N` (default 2000 ms)
for initial composition before the first reset. N must be a non-negative integer;
0 skips this wait. It resets `dumpsys gfxinfo` before each scenario, captures it
afterward, and always attempts to dismiss this prototype on exit.
Plain output is exactly one line per scenario:

```text
scenario=tab-switch frames=100 janky_pct=5.00 p50_ms=8 p90_ms=12 p95_ms=16 p99_ms=22 slow_ui=1
scenario=idle error=missing-fields
```

Percentiles and slow UI counts come directly from gfxinfo. Capture failures or
missing fields produce an error line, continue with remaining scenarios, and exit 1.
An idle dump with no percentile fields reports an error rather than inventing
zero latency; its acceptance metric remains the actual frames rendered in 3 seconds.
`--markdown` prints a table with the same fields and an error column. `--scenario`
is repeatable; selected scenarios retain file order. `--package`, `--spec`, and
`--scenarios` override defaults. `--device` is mandatory except for `--list` and
`--dry-run`; dry-run prints every command, including sleep and cleanup, and runs none.
`PROTOTYPE_BENCH_ADB` and `PROTOTYPE_BENCH_CLI` accept executable paths, such as private
CLI wrappers; the default CLI is `bun <repo>/src/index.ts --cli`.

Baseline: not yet recorded on a device

## Trace sections

The renderer includes `Prototype.validateStateWrite`, `Prototype.prepareStateWrites`,
`Prototype.mapRenderTree`, `Prototype.mapPrototypeSpec`, `Prototype.compose` and `Prototype.node` (#12128).
`Prototype.interact`, `Prototype.syncAppearance` and `Prototype.host.show` are still to be added.
The names are stable so Perfetto queries can be shared between measurements. All sections use the
framework `android.os.Trace` (no new dependency). All sections are emitted only while tracing
is enabled via `Trace.isEnabled` (API 29+); below API 29 none is emitted and no `android.os.Trace`
method is called. The async-section calls also need API 29.

| Section name                   | Insertion point                                                                                                             | Kind                                                               | Status      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| `Prototype.interact`           | `PrototypeController.interact`, inside `mutex.withLock`, from after the stale-runtime check to the end                      | Async section (the body suspends and may resume on another thread) | pending     |
| `Prototype.validateStateWrite` | `PrototypeRuntime.validated`, whole body                                                                                    | Synchronous                                                        | in renderer |
| `Prototype.prepareStateWrites` | `PrototypeRuntime.validated`, only the branch that calls `prepareStateWrites(from)` (first write, and after a host replace) | Synchronous, nested in `Prototype.validateStateWrite`              | in renderer |
| `Prototype.mapRenderTree`      | `PrototypeRenderMapper.map`, the miss path only (after the same-snapshot early return)                                      | Synchronous                                                        | in renderer |
| `Prototype.mapPrototypeSpec`   | `mapPrototypeSpec` in `PrototypeRenderModel.kt`, whole body (the uncached full mapping used outside a runtime)              | Synchronous                                                        | in renderer |
| `Prototype.syncAppearance`     | `PrototypeController.interact`, around `syncAppearance(runtime, model)` and `syncTextFieldFocus(model)`                     | Synchronous                                                        | pending     |
| `Prototype.compose`            | `PrototypeRuntimeContent`, around the `PrototypeSpecContent` call                                                           | Synchronous, begin/end without `try` (composable calls)            | in renderer |
| `Prototype.node`               | `RenderPrototypeNodeContent`, first and last statement of the body                                                          | Synchronous, constant name; slices per frame = nodes recomposed    | in renderer |
| `Prototype.host.show`          | `PrototypeHost.showOnMain`, whole body                                                                                      | Synchronous                                                        | pending     |

The slice count of `Prototype.node` inside one `Prototype.compose` is the number of nodes a state change
recomposed, which is the epic's target metric; `Prototype.mapRenderTree` should appear at most once per
`Prototype.interact`.
