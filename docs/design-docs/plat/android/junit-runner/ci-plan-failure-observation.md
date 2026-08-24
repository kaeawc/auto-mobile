# Plan failures: `failureObservation` and JUnit artifacts

Use this when a YAML plan fails in CI (for example **`tapOn`: element not found**) and you need to know **what was actually on screen** at failure time. This complements [CI daemon logs](ci-daemon-logs.md).

If **`observe`** + **`waitFor`** passed but the next **`tapOn`** fails with **pre-tap re-find / stable bounds** wording (or older flakes where **`tapOn` “succeeded”** but the UI did not change), see **[Android `tapOn` pre-tap stability and search flakes](../tapOn-pre-tap-stability-and-search-flakes.md)**.

---

## What `failureObservation` is

When **`executePlan`** stops on a failed step, the AutoMobile daemon attaches a **`failureObservation`** object to **`failedStep`** in the tool result. It is built from a follow-up **`observe`** (or from the failing step’s payload when the failing tool is **`observe`**).

Typical fields:

| Field                                          | Meaning                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **`capturedAtMs`**                             | Host timestamp when the snapshot was taken                                    |
| **`activeWindow`**                             | High-level app id / activity hint from the daemon                             |
| **`accessibilityState`**                       | Whether accessibility is reported enabled                                     |
| **`viewHierarchy`**                            | Full hierarchy payload (often under **`hierarchy.node`**, from CtrlProxy)     |
| **`awaitTimeout` / `awaitedElement`**          | Present when the observe used **`waitFor`**                                   |
| **`visibleTextsSample` / `resourceIdsSample`** | Flat digests from **`elements.*`** when present (may be **empty**; see below) |
| **`observeError`**                             | Set if the failure snapshot observe itself errored                            |

You need a **daemon build that includes this feature** (pin a recent AutoMobile commit or release). See [CI Integration](ci-integration.md) for **`AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH`** and building **`dist/`**.

---

## Where to find it in CI

| Location                                              | Notes                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **JUnit XML** (`build/test-results/.../*.xml`)        | Often embedded in the **`<failure message="...">`** / CDATA as escaped JSON inside the **`executePlan` output** |
| **`structuredContent.failedStep.failureObservation`** | Same payload when parsing the MCP / daemon JSON response                                                        |
| **Gradle `system-out`**                               | Some runners print the daemon **`Daemon response:`** JSON blob                                                  |

Search the artifact for **`failureObservation`** or **`"packageName"`** next to your launcher package if the XML is huge.

---

## How to interpret it (launcher vs your app)

1. Open **`failureObservation.viewHierarchy`** (and **`activeWindow`** if set).
2. Look for **`packageName`** and node **`resource-id`** / **`view-id`** prefixes.

If you see **`com.google.android.apps.nexuslauncher`** (or another **launcher** package) and **no nodes** for your **`appId`** (e.g. `com.followupboss.fubandroidstaging`):

- At **the instant** that snapshot was taken, the **foreground UI was the launcher**, not your app.
- So **`tapOn`** on strings that only exist **inside your app** (e.g. a server row like **`api.reclients.com`**) **cannot succeed** — the failure matches the tree.

### What this does **not** prove

- It does **not** prove your app **never** appeared during the run. It only proves **at capture time** (immediately around the failed step) the tree looked like the launcher.
- To see **earlier** behavior, use **`daemon.log`**, **screen recording**, and **`logcat`** from the same job.

### Plain-language confirmation

**Yes:** if `failureObservation` shows only the launcher, then **when AutoMobile recorded that snapshot, your app was not the visible UI** — same as “app not visible” for debugging that failure.

---

## Why `observe` step success can disagree with `failureObservation`

Older daemons could **continue `executePlan` after an `observe` whose `waitFor` timed out** (`awaitTimeout: true` in the observe payload) because only `success: false` was treated as a hard failure. That let plans advance with a **stale or wrong screen**, so the next **`tapOn`** failed with a confusing tree (e.g. launcher, or a dialog) while logs still showed the observe “completed.”

**Current behavior (recent `PlanExecutor`):** if **`observe`** returns **`awaitTimeout: true`**, the plan step is **failed** and **`executePlan` stops** with an error like `observe waitFor timed out after …ms`. That matches the intent of `waitFor`: the condition was not satisfied before the timeout.

Other reasons the **next** step can still disagree with an observe that “succeeded”:

1. **Race:** UI matched **`waitFor`** briefly, then the app **went to background** or **crashed** before **`tapOn`**.
2. **Too-loose `waitFor`:** if a condition matches something that is not the screen you think (e.g. first **`id/name`** in a **`RecyclerView`**), the plan advances incorrectly. Use **`waitFor.container`** (same shape as **`tapOn`**) to scope **`elementId`** / **`text`** inside a list, or wait on a **globally unique** id.

**Rule of thumb:** for “what screen are we on **at the failure**?”, trust **`failureObservation`** over a prior step’s log line. For “did we actually satisfy **`waitFor`**?”, check that **`awaitTimeout`** is not **`true`** in the observe result (and upgrade the daemon if timeouts still do not fail the plan).

---

## Server picker dialog before login (`mainBG` never appears) {#server-picker-before-login}

Some staging / fresh-data flows show a **“Choose Server API”** dialog **before** the main login layout. The dialog is its own window subtree: **`com.followupboss.fubandroidstaging:id/alertTitle`** (title), **`com.followupboss.fubandroidstaging:id/select_dialog_listview`**, and rows with **`android:id/text1`** whose **text** is the full URL (e.g. **`https://api.reclients.com/v1/`**), not a short hostname substring alone.

**Symptom after tightening `executePlan`:** step 2 **`observe`** with **`waitFor: elementId: …/id/mainBG`** times out (~15s). **`failureObservation.viewHierarchy`** shows only the dialog and status bar — **`mainBG` is not under the focused window**, so the condition never becomes true.

**YAML hardening:**

1. **First gate after `launchApp`:** wait for the dialog when that is the real first screen, e.g. **`waitFor: text: "Choose Server API"`** or **`elementId: …/id/select_dialog_listview`**, not **`mainBG`**.
2. **Pick the server row:** **`tapOn`** with **`text`** matching what appears in the hierarchy (often the **full URL** string). Partial text match may work but exact string is more stable.
3. **Flows that sometimes skip the dialog:** a single linear plan cannot OR two **`waitFor`** conditions; use a deterministic app configuration for CI, split scenarios, or accept that one ordering is the supported path.

See also [Writing Tests → `observe` (login / server picker)](writing-tests.md#observe-login-server-picker).

---

## Duplicate resource ids in lists (`waitFor` + `container`)

If **`waitFor`** uses **`elementId`** such as **`…/id/name`** inside a **`RecyclerView`**, **`ElementFinder`** returns the **first** matching node in the tree. Search results and list UIs often repeat the same id on every row, so the “match” may be the **wrong row** while the step still “passes” **`waitFor`**.

**Fix:** add **`container`** on **`waitFor`** (optional object, same as **`tapOn`**: exactly one of **`elementId`** or **`text`**) so the match is scoped under that container (e.g. **`…/id/list`**).

---

## Empty `visibleTextsSample` / `resourceIdsSample`

The digest fields are filled from top-level **`elements`** (clickable / text / scrollable) on the observe result. **CtrlProxy**-sourced trees often expose most detail under **`viewHierarchy.hierarchy`** only, so the samples can be **empty** even when **`viewHierarchy` is full**.

**Do not** treat empty samples as “no UI”; read **`hierarchy.node`** for **`text`**, **`content-desc`**, and **`resource-id`**.

---

## Related daemon noise (same failures)

| Symptom                                                                         | Likely cause                                                                                  | Doc                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`PerformanceAudit` / `J.create is not a function`** then screenshot cancelled | **`--ui-perf-mode`** path                                                                     | Check CI integration docs                                                                       |
| **Tiny MP4 (~40 KB), only launcher in video**                                   | Screen finalize / encoding; pin video fixes or **`AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE`** | [Video recording](../../../mcp/observe/video-recording.md), [CI Integration](ci-integration.md) |
| **`grep` with `\|` matches nothing**                                            | Use **`grep -E`** for alternation                                                             | shell docs / CI snippets                                                                        |

---

## Related

- [CI daemon logs](ci-daemon-logs.md) — capture **`daemon.log`**
- [CI Integration](ci-integration.md) — pinned AutoMobile checkout, **`bun run build`**, env vars
- [Writing Tests → observe](writing-tests.md) — `waitFor` schema
