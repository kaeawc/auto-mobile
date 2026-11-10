# Prototype icon selection

`prototype-icon-names.json` is the sorted, authoritative list of 300 supported Material icon names.
The selection retains 147 names from repository icon fields, fixtures, goldens, samples,
documentation examples, icon-specific tests, legacy iOS support and Compose references (including
AutoMirrored icons, Playground, Kotlin and Swift). It includes the complete 49-name Material core set, adding 12 names
beyond that evidence, and 141 common UI names spanning navigation, actions, communication, media,
content, toggles, status, social and commerce. Each name supports all five Material styles.

Edit this data, then run `bun scripts/prototype/generate-prototype-icon-names.ts` to update the
contract enum and the [allowed icon guide](../docs/using/prototype-icons.md). The contract drives
TypeScript and native validation, generated models, embedded Swift data and CtrlProxy's generated
R8 rules. Do not edit the derived enum or R8 rules independently. Run the model, render-contract,
iOS contract and iOS symbol generators, then `bash scripts/update-tool-definitions.sh --no-stage`.
The iOS symbol generator keeps the mapping and fallback partition in contract order; mappings
must follow the SF Symbol availability and restriction rules in `ios/prototype-agent/ICON-SYMBOLS.md`.
