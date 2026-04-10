# YAML test plans: AutoMobile vs Maestro (gaps and corrections)

This document corrects common misconceptions when comparing **AutoMobile’s deterministic YAML plan layer** (driven by `executePlan`, JUnit runner, XCTest runner) with **Maestro** flows. It is not a feature checklist against every Maestro release; it reflects the AutoMobile repo’s **current behavior** and docs.

External references (for orientation only): [kaeawc/auto-mobile](https://github.com/kaeawc/auto-mobile), [mobile-dev-inc/maestro](https://github.com/mobile-dev-inc/maestro).

---

## Video recording

**Correction:** AutoMobile is **not** “missing video for YAML / CI” in the same way as “no capability exists.”

- **`executePlan`** (daemon path) **starts screen video recording automatically** before plan execution and **stops it in a `finally` block**, associating output with test execution metadata when recording succeeds.
- **MCP video recording** (`videoRecording` / related tooling) is **implemented** for record-to-file workflows; see the [Status Glossary](../status-glossary.md) and [Video Recording](../mcp/observe/video-recording.md).

**Remaining difference vs Maestro:** Maestro exposes **explicit** `startRecording` / `stopRecording` (or equivalent) **inside the flow file**. AutoMobile plans do not currently offer **YAML-level** start/stop of segments; you get **whole-plan** recording tied to `executePlan`, plus separate MCP tools for other workflows.

---

## Auto-wait, flakiness, and retries

**Correction:** Deterministic plans are **not** purely “sleep or fail.”

- **`observe`** supports **`waitFor`**: wait until an element (by `text` or `elementId`) appears, or time out and fail the step.
- **`swipeOn`** supports **`lookFor`**: repeat scrolling until a target is found (scroll-until-visible semantics), implemented in the swipe stack (see `ScrollUntilVisible` in source).
- The **[interaction loop](../mcp/interaction-loop.md)** documents **idle detection** (e.g. Android gfxinfo-based) around actions for stable observe/act cycles when using those code paths.
- **JUnit and XCTest plan executors** implement **retries** for transient failures (timeouts, daemon busy, etc.).

**Remaining difference vs Maestro:** Maestro markets **flow-wide “zero wait”** behavior. AutoMobile’s reliability is **tool- and parameter-driven** (use `waitFor`, `lookFor`, retries) rather than a single DSL-level guarantee on every line of YAML.

---

## Scroll until visible

**Correction:** This is **not** a capability gap relative to “only fixed swipes.”

- Use **`swipeOn`** with **`lookFor`** `{ text: "…" }` or `{ elementId: "…" }` (exactly one selector field) to scroll until the target appears or limits/timeouts apply.

The Maestro command name `scrollUntilVisible` differs, but the **pattern is supported** as a normal plan step.

---

## Assertions and `observe` / `waitFor`

**What YAML-native steps can express today**

- **`observe` + `waitFor`** matches **“element must appear within timeout”** (similar in intent to Maestro **assertVisible** / eventual presence checks). If the element does not appear, the step fails.

**What they do not replace**

- **Negative visibility** (“this text must **not** be on screen” / `assertNotVisible`): `waitFor` only encodes **presence**. There is no documented **`waitUntilGone`** / **`mustNotSee`** on `observe`. A plain **`observe`** without `waitFor` **succeeds** when the screen is captured; the plan executor does **not** automatically fail based on hierarchy content for arbitrary “must not see” rules.
- **Rich or composite asserts** (enabled state, exact counts, arbitrary boolean logic, inline scripts): Maestro-style **JavaScript** or broad assert commands have **no equivalent** in plan YAML alone; you need **host assertions** (JUnit / XCTest) on tool results or new server capabilities.

**Schema note:** The test plan JSON schema allows **`expectations`** on steps, but **TypeScript `PlanExecutor` does not evaluate them** today; unknown fields may be stripped when invoking tools. Do not rely on `expectations` as enforced assertions until execution support exists. Standalone **`await` / `assert` YAML step types** remain **design-only**; see [executePlan assertions](../plat/android/executeplan-assertions.md).

---

## Declarative control flow in YAML

**Still a real gap:** plans are essentially **ordered `steps`** (tool invocations). There is **no** first-class **`when:`**, **loops**, **`runFlow` / includes**, **`onFlowStart` / `onFlowComplete`**, or **inline JS** in the plan schema comparable to Maestro’s flow language.

**Rough implementation order of ideas** (for planning, not a commitment): environment **parameterization** and **tags** are smaller than a full **control-flow interpreter** (branching, subflows, loops, safe limits, multi-device semantics).

---

## Tags and suite filtering

**Gap in YAML:** the standard test plan schema does **not** define Maestro-style **`tags:`** plus **`includedTags` / `excludedTags`** on the CLI.

**Practical substitute:** use **test framework tags** on the code that runs a plan, for example **JUnit 5 `@Tag("smoke")`** on the class or method that loads a given YAML file, and filter in Gradle / CI. That achieves **the same CI outcome** (PR smoke vs nightly full suite) without extending the YAML format.

**Tradeoff:** tags live on the **runner**, not inside the **`.yml` artifact**; portable “this file is smoke” metadata travels better with **in-file tags** if you later add them.

---

## Parameterization (environment variables)

**Gap:** there is **no** documented, first-class **`${VAR}`** (or similar) substitution across plan YAML like Maestro’s `-e` / flow env. Top-level **`parameters`** in the schema is **deprecated**.

**Typical use cases if you add it later**

- Different **app ids**, **deep links**, **accounts**, or **environment-specific strings** without duplicating whole plans.
- CI matrix or job env vars injected once at the runner.

**Workaround today:** generate or wrap plans in **Kotlin/Swift/Java** tests, or preprocess YAML before `executePlan`.

---

## CI / “plugins”

**Correction:** AutoMobile is **not** only “generic CLI with no CI helpers.” This repository ships **reusable GitHub Actions** under `.github/actions/` (for example emulator/setup helpers). That is narrower than Maestro’s **documented multi-vendor plugin catalog**, but it is **more than zero** for GitHub Actions users.

---

## Quick reference

| Topic | Common claim | Accurate summary |
|--------|----------------|------------------|
| Video | Missing for YAML/CI | **Whole-plan** recording on **`executePlan`**; MCP video tools exist. Gap: **YAML-scoped** record start/stop. |
| Auto-wait | None in deterministic mode | **`waitFor`**, **`lookFor`**, interaction **idle** behavior, **retries** — not Maestro’s single “zero wait” story. |
| Scroll until visible | Only manual swipes | **`swipeOn` + `lookFor`**. |
| Assertions | Only AI or host code | **`observe.waitFor`** covers **presence**; not **absence** or full Maestro assert/JS surface. |
| Control flow | — | **Real gap** (conditions, loops, subflows). |
| Tags | Must be in YAML | **JUnit `@Tag` (etc.)** replicates **filtering**; YAML tags still absent. |
| Parameterization | — | **Real gap** for `${VAR}`-style plans; workarounds in test code or preprocessing. |
| CI | No plugins | **In-repo GitHub Actions** exist; not a full Maestro-style marketplace story. |

---

## Related docs

- [Tools](../mcp/tools.md) — MCP tool surface
- [Interaction loop](../mcp/interaction-loop.md) — idle detection and observe/act cycle
- [executePlan assertions](../plat/android/executeplan-assertions.md) — assertion design and current limits
- [Status Glossary](../status-glossary.md) — implementation chips and known gaps
- [UI Tests](../../using/ui-tests.md) — user-facing test workflow
