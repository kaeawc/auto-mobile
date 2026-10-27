# ProtoViewer agent: on-device authoring and tool surfaces

Status: draft design for prototyping, not implemented. Nothing in this document exists in the
ProtoViewer apps today; every section that describes behavior is planned unless it says "landed".
The accepted design lists an editor as a non-goal for the first release, so this work is post-first-release
exploration; if it is accepted it amends that non-goal and the `source` values in
[ProtoViewer](protoviewer.md) section 4.
No issues are filed yet. It builds on the accepted [ProtoViewer](protoviewer.md) design (epic
#13625), which it must not contradict, and on the platform vocabulary contract (#14294).

ProtoViewer today is a library and viewer: prototypes are written by an agent on a host and then
saved, imported or shared. This document explores two paths that let ProtoViewer work without
any AutoMobile host (no daemon, no MCP server, no adb):

- **Path A, authoring agent.** A Koog agent inside ProtoViewer generates and edits prototypes on
  the device. Its write tools reuse the MCP `prototype` tool's `patch` and `inspect`, and add
  read tools that tool does not have (section 4.1).
- **Path B, tool surfaces.** Tools the user needs are exposed as platform modules, and the
  surfaces for those tools are themselves prototype specs: generated from the tool's argument
  schema, or composed by the Path A agent for the task at hand.

The model can be a cloud model (the user's own key) or an on-device model. The owner wants both
paths and both kinds of model prototyped (2026-10-22).

## 1. Current state

**ProtoViewer apps (landed under epic #13625)**

- Android: the `:protoviewer` module (`dev.jasonpearson.automobile.protoviewer`, minSdk 26) with the
  library list, per-prototype task, relaunch and reset (#14963), import, share and delete (#14969),
  the global network switch and local-network permission (#14972), and hardening: switch
  revocation, the 100 MiB library cap and the 10 s render watchdog (#14975, #15011, #15063). It
  builds on `:prototype-compose` (renderer, `AutoMobilePrototype`), `:prototype-saved` (saved store
  and device HTTP transport, #13617) and `:protocol`.
- iOS: the SwiftUI `ProtoViewer` target in `ios/prototype-agent` with the library list, open,
  relaunch and reset (#14964), import, share and delete (#14971), and the global network switch on
  the pinned Network.framework transport (#15055). Both apps show a provenance band outside the
  spec's bounds while the network switch is on.
- Bundle format and the strict zip reader in TypeScript, Kotlin and Swift (#14867), and the Swift
  `PrototypeSpecStrictValidator` with the shared corpus (#14866, closing #13620).
- Library-mode rules in all three validators: `library: true` rejects privileged windows, `via:
  "host"` requests and secure (password) values bound into requests, data writes, `emit` context,
  `platform` arguments or `storage` (`via: "host"` and privileged windows: #14944, #14866; secure bindings: #14970, #15011).
- Still open under the epic: MCP routing of `prototype save` and `open` (#13621), the rest of the
  shared hardening (#13622) and the release (#13623). The ProtoViewer apps are not yet exercised by
  CI (#15064) and have no device verification for the permission flows.

ProtoViewer has no authoring surface: it can show, relaunch, reset, share and import prototypes
that were written elsewhere. Everything below builds on those pieces and does not change the
library store layout, the bundle format or the import flow.

**Renderer and spec operations**

- Android: the embeddable renderer `AutoMobilePrototype` lives in `:prototype-compose`. The spec
  validator (`PrototypeSpecValidator`) and the patch applier (`PrototypePatch`) live in
  `android/protocol`. `PrototypeRuntime.patch()` applies a patch to a running prototype.
- Patch scope matters for the agent: `PrototypePatch` writes only under `/data` and `/state`
  (`add`, `replace`, `test`, `remove`), and `replaceNode` is the only way to change the node tree.
  `root`, `window` and `theme` are not patchable, and `replaceNode` cannot replace the root; those
  changes are a whole-spec `show`.
- iOS: `PrototypePatch.swift` and `PrototypeSession` in `AutoMobilePrototypeAgentCore`, and the
  `PrototypeModel(mode: .standalone)` used by ProtoViewer. The Swift validator has landed, so iOS
  can reject model output with the same corpus-checked rules as TypeScript and Kotlin.
- `components` / `use` expansion exists only on the host (`expandPrototypeComponents` in
  `src/features/prototype/prototypeComponents.ts`). Devices receive expanded specs, and the
  ProtoViewer import path accepts only expanded specs.
- The platform vocabulary uses the shared `platformModules` contract and native registries.
  `device` publishes read-only device state; `clipboard` provides `copy`, `paste` and `hasText`
  without events or state. Clipboard text is bounded to 65,536 UTF-8 bytes; pastes truncate at a
  Unicode scalar boundary and write `{text, truncated}` to `/data`. Copy can mark content
  sensitive (Android's sensitive clip flag; iOS local-only with a 60-second expiration).
  Completion and fake-clipboard audit metadata contains only `op` and `bytes`, never text.
  `pasteButton` uses the system SwiftUI paste control on iOS and dispatches `clipboard.paste`
  from an ordinary button on Android. It owns its tap action while retaining common layout fields.
  CtrlProxy temporarily acquires prototype-window focus for clipboard reads and restores its flags.
  The placeholder `test` module is available only in test/debug registrations.

**Koog (checked 2026-10-22)**

- The repo pins `koog-agents` 1.3.0, used only by `android/junit-runner` for AI test recovery.
- Cloud clients: Anthropic, OpenAI, Google, Bedrock, Mistral, OpenRouter, DeepSeek, DashScope
  and Ollama.
- Local: `prompt-executor-litert-client` (`LiteRTLLMClient`, Android only, since 1.0). It runs
  `.litertlm` models such as Gemma from the litert-community set, with tool calling; several tool
  calls per response since 1.1.1. The session is recreated whenever history, tools or settings
  change, so the tool set should stay fixed for a session.
- `DynamicPromptExecutor` (1.1.1) resolves the model per call, which suits routing between a local
  and a cloud model.
- Not in Koog: Gemini Nano (ML Kit GenAI / AICore) and Apple's Foundation Models framework.
- Koog publishes Kotlin/Native klibs, including iOS targets. Whether a Swift app can use Koog
  through a KMP framework is a spike question (section 9).

**Lessons from Pocket** (`~/kaeawc/pocket-android-app`, Koog, Compose, Metro)

| Keep                                                                                                               | Avoid                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| One typed argument schema (`ToolParamType`) drives both the generated Compose form and the model's tool descriptor | Plain-text tool results parsed by regex, in a 94-branch `when` over tool names (`ToolOutputRenderers.kt`) |
| A runtime registry as a `StateFlow`, so tools can come and go                                                      | No consent gating: side-effecting tools (for example SMS) run immediately                                 |
| `ToolResultAction`: a result links to another tool with arguments pre-filled                                       | A Koog adapter that flattens nested arguments to strings                                                  |
| `StuckDetector`: a sliding window over (tool, arguments) that warns the model when it repeats itself               | Koog wired but never run: no agent loop, no turn caps, no cancellation                                    |
| A fake `PromptExecutor` that replays a queue of responses, for deterministic loop tests                            |                                                                                                           |
| Keys in Keystore-backed encrypted preferences, never shown to the model                                            |                                                                                                           |

## 2. Goals and non-goals

Goals

1. Create a prototype from a description, and edit one by instruction, on the device, with no
   AutoMobile host.
2. Every model output is checked by the same validator as an import. An invalid output never
   renders and never reaches the library.
3. Edits are revisions: preview, apply, discard and undo.
4. The same agent runs on a cloud model or an on-device model, chosen per task or forced to
   local-only by the user.
5. Tools become platform modules; their surfaces are prototype specs, either generated
   deterministically or composed by the agent.
6. Side-effecting tool calls always go through a confirmation that ProtoViewer draws, not the
   spec.
7. Android and iOS share the tool contracts, even where the model runtime differs.

Non-goals: running code from a model (specs stay declarative), privileged windows, accounts or
sync, store listings in the first release (GitHub releases only, as in [ProtoViewer](protoviewer.md) section 8),
porting Pocket's tool catalog (Pocket lives in a separate repository; only its patterns are
reused), and replacing MCP-driven authoring from a host.

## 3. Architecture

```
ProtoViewer
├── Library and viewer (landed, epic #13625)
├── Agent (Path A)
│   ├── Model router: cloud client | LiteRT | (later) Gemini Nano / Foundation Models
│   ├── Spec tools: outline, read, validate, patch, replaceNode, preview, inspect, events
│   └── Guards: turn cap, token budget, stuck detector, cancellation
├── Draft store: revisions per library id (draft → applied)
└── Platform registry (#14295 / #14296)
    ├── Tool modules (Path B), each a platformModules entry
    └── Consent sheet drawn by the app, outside the spec's bounds
```

Everything in the diagram except the library and viewer is planned. Both paths share one rule: **the model writes only through spec tools, and every write is
validated.** The agent never gets a raw "write file" or "set spec" escape hatch.

## 4. Path A: authoring agent

### 4.1 Spec tools

Two tools reuse MCP `prototype` actions (`patch`, and `inspect` / `events` from `inspect` and
`awaitEvent`), so prompts and evaluations carry over for edits. The rest (`outline`, `readNode`,
`readData`, `capabilities`, `validate`, `preview`, `askUser`) are new:

| Tool                         | Effect                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `outline`                    | A compact tree: node id, type, label or text, child count. The main context the model sees for a large spec.                          |
| `readNode(id)`               | The full JSON of one subtree.                                                                                                         |
| `readData(ptr)`              | A slice of `/data`, or the declared `state` keys.                                                                                     |
| `capabilities`               | The capability set and the platform modules this ProtoViewer build advertises.                                                        |
| `validate(spec)`             | Accept, or the error path and message. Used for a whole new spec.                                                                     |
| `patch(ops)`                 | JSON-Patch subset plus `replaceNode`, against the draft's revision. Validates the result; returns the new revision or the error path. |
| `preview`                    | Renders the draft and returns an `observe`-style summary of what is on screen, so the model can check layout.                         |
| `inspect`, `events`          | Runtime state and recent events (`emit`, `change`, `validation_failed`) after the user tries the draft.                               |
| `askUser(question, options)` | Shows a choice in the agent sheet, for genuine ambiguity.                                                                             |

A rejection is returned as the tool result with its path, and the model retries; Koog's tool
error result carries it. Create-from-description starts from a template spec (section 4.4) and is
then a series of patches, so small models are never asked to produce 1 MiB of JSON at once.

### 4.2 Drafts and revisions

- Each library entry gains a draft: the applied spec plus a list of revisions, each with its
  patch, author (`agent` or `user`), instruction and timestamp. Undo walks the list. Drafts live in
  a sibling file next to `library.json`; the per-platform `manifest.json` files stay untouched, as
  the accepted design requires.
- **Apply** writes the draft through the normal import commit (validator with `library: true`,
  capability check, atomic commit). The accepted design creates a new entry with its own library id
  and empty storage whenever a spec is imported, and defers replace and keep-both to Phase 2. So
  the first spike applies a draft as **Save as new**; replacing an entry in place needs the Phase 2
  replace semantics first. **Discard** drops the draft. How stored values survive an applied
  structural change is an open question (section 10).
- A prototype created by the agent gets a new `source` value, `generated`, in `library.json`. Today
  the source is one of `mcp`, `file`, `share` or `paste`, always written by the importing code and
  never read from bundle bytes; `generated` follows the same rule. `LibrarySource` (Kotlin) and the Swift entry's source are closed
  enums, so an older build skips such an entry, as it skips any unreadable `library.json` entry
  (not fatal); a downgrade hides generated prototypes and does not break the library. It follows the
  imported-prototype policy: network off unless the global switch is on, `via: "host"` rejected, no
  privileged window.
- Exported bundles stay canonical: revision history, drafts and instructions are never exported.

### 4.3 Context budget

The full spec limits (1 MiB, 2000 nodes, depth 24) are far beyond a small model's context. The
agent never puts the whole spec in context:

- `outline` is the default view; `readNode` loads only the subtree it needs.
- **Selection is context.** In edit mode, a tap on the canvas selects a node instead of running
  its action. The selected id and its subtree are added to the next instruction, which makes
  `replaceNode` the common edit.
- A compact spec guide for the model (node types, actions, bindings, limits) is generated from
  `schemas/prototype-spec-contract.json` at build time, so it cannot drift. There is one full
  version for cloud models and one short version for on-device models.

### 4.4 Templates and components

- Built-in templates (list and detail, form, tabbed app, settings, feed) are ordinary valid specs
  shipped with the app and checked against the shared corpus.
- `components` / `use` lets the model reuse a block instead of copying it. Expansion exists only in
  TypeScript today, and the spec contract has no `components` field, so on-device authoring needs
  Kotlin and Swift ports of `expandPrototypeComponents`, replayed against the same fixtures. Until
  then the agent writes expanded nodes.

### 4.5 Models

| Tier                        | How                                                                                                                              | Fits                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Cloud, user's own key       | Koog Anthropic, OpenAI or Google client. Keystore-encrypted key, entered in settings, never in a spec or tool argument.          | New prototypes from a description, multi-screen edits |
| On-device, LiteRT (Android) | Koog `LiteRTLLMClient` with a `.litertlm` Gemma model the user downloads on demand (never bundled in the APK), checked by sha256 | Patch-sized edits on a selected node; fully offline   |
| On-device, Gemini Nano      | ML Kit GenAI Prompt API behind a custom Koog `LLMClient`                                                                         | Research: device coverage, tool calling, context size |
| iOS                         | Koog through a KMP framework, or the Foundation Models framework with the same tool contracts in Swift                           | Spike decides (section 9)                             |

A `DynamicPromptExecutor` routes each task: an edit scoped to one node goes local when a local
model is installed, and a new prototype goes to the cloud unless the user chose **Local only**. A
local session keeps its tool set fixed, because a change recreates the LiteRT session.

### 4.6 Guards

- A turn cap and a token budget per instruction, with a visible counter.
- A stuck detector in Pocket's style: the same tool with the same arguments twice within six
  calls adds a warning to the next turn; a third time stops the run.
- Cancellation from the agent sheet. Dismissing the viewer cancels the run.
- Runs only in the foreground; no background service. Wall-clock limits use the injected clock,
  with a fake timer in tests.

### 4.7 UX

- An **Edit** button in the viewer chrome (the app-reserved region, outside the spec's bounds)
  opens the agent sheet: instruction field, the selected node, progress and the revision list.
- The changes are shown before apply: changed nodes are highlighted on the canvas, and the
  revision has a short summary the agent writes.
- **New from description** in the library: pick a template or none, describe it, review the
  draft, save.
- On iOS everything uses SF Symbols.

## 5. Path B: tool surfaces

### 5.1 Tools are platform modules

Tools use the vocabulary #14294 already defines, with no new action type:

A fragment (the spec's `id`, `window` and the declared `state` keys `amount`, `from` and `to` are
omitted):

```json
{
  "requires": { "platform": ["units"] },
  "root": {
    "type": "button",
    "id": "convert",
    "label": "Convert",
    "onTap": [
      {
        "type": "platform",
        "call": "units.convert",
        "args": {
          "value": { "state": "amount" },
          "from": { "state": "from" },
          "to": { "state": "to" }
        },
        "into": "/data/result",
        "statusKey": "convertStatus"
      }
    ]
  }
}
```

- Each tool module is a `platformModules` entry in the contract: its calls, typed arguments,
  permissions, and the `sensitive` flag. Its gate is `prototype_platform_<module>_v1`. Today the
  table has only the placeholder `test` module, so every real module below is planned.
- ProtoViewer registers its tool modules in the registry (#14295 / #14296, both open) and
  advertises exactly those capabilities. A spec that needs a module this build lacks gets "needs a newer
  ProtoViewer", as for any capability.
- Results are typed JSON written to `into`, never text for the renderer to parse. Each call will
  declare its result shape in the contract; no result-shape field exists today (planned).

### 5.2 Generated surfaces

A deterministic generator turns an op's argument definitions into a form spec, with no model
involved:

| Argument type      | Node                                          |
| ------------------ | --------------------------------------------- |
| string             | `textField`                                   |
| number with bounds | `slider`, else `textField` (numeric keyboard) |
| boolean            | `switch`                                      |
| enum               | `select`, or `segmentedButton` for up to 4    |
| date, time         | `datePicker`, `timePicker`                    |
| list of enum       | a `flow` of `chip` nodes                      |

The result renders with a template keyed by the op's result shape (`repeat` over a list,
`listItem` and `card` for records). A generic key and value template covers results without one.
A result can link to another op with arguments pre-filled (Pocket's `ToolResultAction`), using
`push` plus `setState`. Generated surfaces are ordinary specs: they validate, save, share and
restyle like any other.

### 5.3 Agent-composed surfaces

With Path A, the user can describe a task and the agent composes a surface for it, wiring
`platform` calls to registered modules: for example "split this bill" composes amount, people and
tip fields and shows the result from a module that does the arithmetic. The agent may use only modules the build advertises
(`capabilities` tool), and the validator enforces `requires`, so a composed surface cannot call a
module it did not declare.

### 5.4 Consent and secrets

- Every op with `sensitive: true`, and every op that writes, sends or spends, goes through a
  confirmation sheet that ProtoViewer draws outside the spec's bounds. It shows the call and its
  resolved arguments. A spec cannot draw, skip or pre-approve it, and an agent tool call cannot
  answer it.
- Credentials live in the module, in Keystore-backed storage (iOS: Keychain). They are never
  arguments, never in `/data` and never in the model's context. The validator already enforces
  the spec side for library prototypes: a secure (password) value cannot be bound into `platform`
  arguments, requests, data writes, `emit` context or `storage` (#14970).
- Network-backed modules use the same egress policy as `request` for library prototypes
  ([ProtoViewer](protoviewer.md) section 6): the global switch (default off), the resolved-address
  egress check, and the pinned transport on iOS. The provenance band stays visible while the switch
  is on. Where integrations execute is still being decided (#14289).

### 5.5 First modules

Start with modules that need no permission and no account, so the registry, generator and consent
sheet are exercised before anything risky:

1. The contract's `test` module (`test.echo` and the `tick` event), already defined; it is a
   placeholder with no real effect.
2. `units` and `calc`: pure, offline.
3. `clipboard` and `share`, taken from the platform areas of #14178.
4. One read-only device module, such as battery or connectivity.

Account-backed and side-effecting modules come after the consent sheet is proven.

## 6. Security

- **Model output is untrusted**, exactly like an imported spec: strict validator, capability
  check, no privileged window, no `via: "host"`, network policy for imported prototypes.
- **Prompt injection.** Text from `/data`, request responses, tool results and imported specs
  reaches the model as tool results, marked as data. The agent's tool set has no write path
  outside the draft, and side effects need user consent, so an injected instruction can at most
  produce a draft the user reviews.
- **Model downloads** come from a pinned list with sha256, over https, on user request, with the
  size shown first.
- **No telemetry of prompts or specs.** Cloud calls go only to the provider the user configured.

## 7. What has to land first

| Need                                            | Status / issue                                                  |
| ----------------------------------------------- | --------------------------------------------------------------- |
| ProtoViewer apps, library, import and storage   | Landed (#14963, #14969, #14972, #14975, #14964, #14971, #15055) |
| Bundle format and strict reader                 | Landed (#14867)                                                 |
| Swift validator parity                          | Landed (#14866, closing #13620)                                 |
| Library-mode rules and secure-binding rejection | Landed (#14970)                                                 |
| MCP routing, shared hardening, release          | Open (#13621, #13622, #13623)                                   |
| Platform module registries                      | Open (#14295, #14296)                                           |
| `platform` vocabulary and generated gates       | Landed (#14294)                                                 |
| Kotlin and Swift `components` / `use` expansion | New                                                             |
| Contract-generated spec guide for models        | New                                                             |
| Consent sheet and sensitive-op policy           | New (relates to #14293, #14297)                                 |

## 8. Testing

- Agent loops run against a fake `PromptExecutor` that replays scripted responses (Pocket's
  pattern), with a fake clock. Each test asserts the tool calls made, the revisions produced, and
  that invalid outputs never reached the draft.
- Spec tools reuse the shared corpus in `test/fixtures/prototype-spec` and the existing patch
  tests (`PrototypePatch` in Kotlin, `PrototypePatchTests` in Swift).
- The surface generator has golden specs per argument type, and every generated spec must pass
  the validator.
- Tool modules get `FakePlatformModule` tests from #14295.
- **Model evaluation is separate from unit tests:** a fixed set of authoring tasks (create a login
  screen, add a tab, make a list editable), each scored by first-try validity, retries, patches
  per task, latency and tokens. It runs on demand on a device per model tier, never in the unit
  lane.

## 9. Prototyping plan

Spikes are throwaway-friendly and land behind a flag that does not exist yet (`:protoviewer` has
no product flavors today).

| Spike | Scope                                                              | Exit criteria                                                                               |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A1    | Android, cloud model: spec tools, drafts, agent sheet, guards      | The evaluation tasks finish with valid drafts; undo works                                   |
| A2    | Android, LiteRT Gemma: node-scoped edits with the short spec guide | Measured validity and latency per model on one device; go or no-go for local-only           |
| A3    | iOS: Koog through KMP versus Foundation Models, same spec tools    | A recommendation with app-size and latency numbers                                          |
| A4    | Gemini Nano through ML Kit GenAI behind a Koog client              | Device coverage, tool calling and context size documented                                   |
| B1    | Registry plus generator with the `test` module, on Android         | A generated form calls `test.echo` and renders the result                                   |
| B2    | `units`, `calc`, `clipboard`, the consent sheet                    | A sensitive op cannot run without the sheet; specs cannot bypass it                         |
| B3    | Agent-composed surfaces (needs A1 and B1)                          | The agent composes a working surface from a task description, using only advertised modules |

A1 can start now: the Android app has landed, and its import commit is the path an applied draft
takes. B1 needs the Android registry (#14295); until then B1 can only exercise the placeholder
`test` module.

## 10. Open questions

1. **Tool modules in the contract.** `platformModules` is a static table, which keeps validation
   strict. Do all ProtoViewer tool modules live in the shared contract (validated everywhere), or
   does ProtoViewer get a separate, app-local section?
2. **Which local models**, and is a download of several hundred MB acceptable for local-only use?
3. **iOS model runtime**: Koog through KMP, or Foundation Models in Swift (A3)?
4. **Sharing generated prototypes**: same as any library entry (canonical bundle, no history), or
   marked as generated in the bundle?
5. **Cloud providers in the first spike**: Anthropic only, or Anthropic, OpenAI and Google?
6. **Stored values across edits**: when an applied edit removes or renames declared storage keys,
   are the old values dropped, kept until reset, or migrated by the agent?

## 11. Risks

1. Small on-device models may not produce valid patches often enough; the evaluation set decides
   whether local-only is offered at all.
2. The Swift validator is reject-only: iOS can safely reject model output but a rejected draft
   gives no partial render model, so the agent depends on the error path and message alone to
   retry.
3. A growing tool catalog bloats the contract and each runtime's advertised set; modules must stay
   per build and per capability.
4. The consent sheet is the only guard on side effects, so it needs its own tests and review.
5. Cloud cost and key handling are the user's responsibility; the app shows token use per run.
