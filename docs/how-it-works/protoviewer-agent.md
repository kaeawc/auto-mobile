# ProtoViewer agent: on-device authoring and tool surfaces

Not implemented. ProtoViewer has no on-device authoring agent and no tool surfaces: it shows,
relaunches, resets, shares and imports prototypes written elsewhere ([ProtoViewer](protoviewer.md)).
The draft design (a Koog authoring agent inside ProtoViewer, and tools exposed as platform modules
whose surfaces are prototype specs) is an idea in the devlog entry under Background; no issues are
filed for it.

Current facts that design builds on:

- Patches (`PrototypePatch` in `android/protocol`, `PrototypePatch.swift` in
  `AutoMobilePrototypeAgentCore`) write only under `/data` and `/state` (`add`, `replace`, `test`,
  `remove`); `replaceNode` is the only way to change the node tree. `root`, `window` and `theme` are
  not patchable and `replaceNode` cannot replace the root; those changes need a whole-spec `show`.
- `components` / `use` expansion exists only on the host (`expandPrototypeComponents` in
  `src/features/prototype/prototypeComponents.ts`). Devices receive expanded specs, and the
  ProtoViewer import path accepts only expanded specs.
- `library.json` `source` is one of `mcp`, `file`, `share` or `paste`, always written by the
  importing code and never read from bundle bytes.
- The repository pins `koog-agents` 1.3.0, used only by `android/junit-runner`.

## Background

- [ProtoViewer on-device agent and tool surfaces](../devlog/2026-10-23-protoviewer-agent-design.md)
