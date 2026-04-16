# Android `tapOn` flakes after `observe` (search lists, `tapClickableParent`)

<kbd>✅ Implemented</kbd>

This document captures a real production flake (FUB **`TaskTest`**: select **“Dan Corkill”** from person search after typing in **`SearchActivity_`**), everything that was tried, and **what actually fixed it**.

---

## What actually fixed it (read this first)

The flake was **not** primarily “wrong tap coordinates” or “semantic click ignored the row.” It was **timing + tree churn**: the row existed when **`observe`** + **`waitFor`** passed, then **disappeared** from the accessibility tree (loading overlay, list refresh, IME) **before** the tap ran. Older behavior could still **report tap success** using **stale bounds** from the pre-tap observation, so the UI never advanced and the next step timed out.

**The fix that stuck** is two parts in the MCP server (Android **`tapOn`** path in `TapOnElement`):

1. **Pre-tap stable re-find (hard guard)**  
   After the initial element resolution, **refresh the hierarchy** several times, **re-find** the same target each time, and require **two consecutive** re-finds whose **bounds match within a small ε** (`boundsNearlyEqual`). **If that never happens, abort the tap** with a clear error instead of tapping pre-observe coordinates.  
   - Code: `resolveAndroidStableTapTargetAfterRefreshes` in `src/features/action/TapOnElement.ts`  
   - Utility: `boundsNearlyEqual` in `src/utils/bounds.ts`

2. **Loading-aware patience (so the guard can succeed)**  
   If the current tree **looks like a blocking loading state** (progress indicators, common loading view classes / resource ids), **extend** the pre-tap refresh budget (default **8** attempts → up to **32**), with a short delay between attempts, so the list can **come back** before we give up.  
   - Code: `androidViewHierarchyIndicatesLikelyBlockingLoading` in `src/utils/androidTransientLoading.ts`

Together: **don’t tap on ghosts**, and **wait long enough through real loading** for the row to reappear in the a11y tree. After this landed, the same plan **passed repeatedly** (e.g. four consecutive runs) where step 28 had previously been flaky.

**Policy note:** The **two consecutive** ε-stable re-finds apply to **churn-prone selector paths** (`tapClickableParent`, `siblingOfText`, `clickable`, `scrollableContainer`). Plain **`text`** or **`elementId`-only** taps still require a **live re-find** after refresh but only **one** successful stable match, so static labels are not held to the same double-stability bar as search list rows.

---

## Symptom

- **`observe`** with **`waitFor`** on the row text (often scoped with **`container`**) **succeeds**.
- Immediately after, **`tapOn`** with **`tapClickableParent: true`** on the same text **either**:
  - reported **success** but the screen **did not change**, and a later **`observe`** timed out, **or**
  - failed with an error about **not re-finding** the target after refreshes (after the guard was added).

Daemon / failure artifacts sometimes showed **`progress_bar_loading`** (or list chrome missing) at failure time while **`SearchActivity_`** was still the active activity.

---

## Root cause (why `observe` could lie to the plan)

1. **Stale snapshot vs. live tap**  
   The plan advances on a hierarchy where **“Dan Corkill”** is present. A few hundred milliseconds later, the app can show **loading** or replace the list; the **accessibility tree no longer contains** that node.

2. **Unsafe fallback**  
   If refresh **did not** re-find the node but code still used **old bounds**, **`dispatchGesture` / ADB tap** could “succeed” at the transport layer **without** activating the intended list row.

3. **Short polling window**  
   Even with re-find logic, a **small** fixed number of refreshes could expire **while** a loading overlay hid rows, so the tool aborted **or** (before the guard) tapped the wrong state.

---

## What we tried (historical, partial, or orthogonal)

These changes **improved** robustness or diagnostics and are worth keeping in mind, but **they did not alone** eliminate the Dan Corkill flake:

| Area | What we tried | Why it wasn’t sufficient alone |
|------|----------------|----------------------------------|
| **CtrlProxy / semantic tap** | **`ACTION_CLICK`** with bounds disambiguation, multi-window search, hit-test ordering, framework id handling (`android:id/*` vs app ids) | Still need a **real node** matching the row; semantic success doesn’t help if the tree **dropped** the row. |
| **Coordinates** | **`tapClickableParent`**: label∩row overlap, clamped centers, ADB-before-gesture for search+IME | Wrong if bounds refer to a **row that no longer exists** in the current tree. |
| **Snapshot consistency** | Ensure tap target and geometry come from the **same** refreshed hierarchy | Necessary but not enough if the next refresh **still** has no row. |
| **Diagnostics** | **`tapDebug`**, focus/hit-test around tap, plan **`failureObservation`** on observe timeout | Great for proving **loading / missing row**; doesn’t fix timing. |
| **Plans** | **`waitFor.container`**, tighter waits | Reduces false positives; doesn’t remove the **gap** between end of observe and start of tap. |

---

## Implementation reference (for maintainers)

| Piece | Location |
|-------|-----------|
| Pre-tap loop + stability requirement | `src/features/action/TapOnElement.ts` — `resolveAndroidStableTapTargetAfterRefreshes`; match count from `src/features/action/androidPreTapStablePolicy.ts` |
| Bounds ε comparison | `src/utils/bounds.ts` — `boundsNearlyEqual` |
| Loading heuristic | `src/utils/androidTransientLoading.ts` |
| Unit tests | `test/utils/bounds.test.ts`, `test/utils/androidTransientLoading.test.ts` |

Typical **success** log line:

```text
[TapOnElement] Android tap target stable after N refresh(es) (bounds matched on last 2 consecutive re-finds, ε=3px)
```

When loading extension applies:

```text
[TapOnElement] Android pre-tap: loading/progress indicators present; extending refind attempts to 32
```

Failure (guard working, UI still churning):

```text
Android tap aborted: could not re-find the target ... (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation).
```

---

## Plan authoring tips (belt-and-suspenders)

- Prefer **`waitFor`** that matches what must be **true immediately before** the tap (row visible **and** stable if the app does a two-phase load).
- Use **`container`** on **`waitFor`** / **`tapOn`** when the text can appear outside the list.
- If a screen always shows a **short loading state** after search, consider an extra **`observe`** with **`waitFor`** on a **stable** list id or row **after** loading clears (defensive; server-side patience above should cover many cases).

---

## Daemon / bundle caveats (debugging only)

When reading **daemon** logs, you may see issues that **do not** change the above root cause but **do** muddy diagnostics:

- **`getUiAutomatorHierarchy` is not a function** (minified `J.*`) — UI Automator fallback from `refreshAndroidViewHierarchy` can fail in some **packaged** daemon builds; prefer a build where native helpers export correctly.
- **`PerformanceAudit` … `J.create is not a function`** — separate bundle/minification issue.
- **`NAV_SCREENSHOT` … Unsupported platform: undefined** — screenshot path missing **`platform`**; unrelated to tap re-find logic.
- **`CTRL_PROXY` Timeout waiting for fresh data** — hierarchy may be slightly stale; the pre-tap loop is meant to cope by **re-fetching** right before tap.

If logs show **`pre-tap refresh attempt …/8`** with **no** “extending refind attempts” line, the running server may be **older** than the loading-extension change, or the app’s loader **does not** match the [loading heuristic](../../../../src/utils/androidTransientLoading.ts) (extend patterns there if needed).

---

## See also

- [Android Control Proxy](control-proxy.md) — accessibility service and CtrlProxy
- [MCP tools](../../mcp/tools.md) — **`tapOn`** selector overview  
