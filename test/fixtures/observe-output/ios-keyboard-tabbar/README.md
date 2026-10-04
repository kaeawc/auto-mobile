# iOS keyboard and tab bar capture

Captured on an iPhone 18 Pro simulator in the iOS Playground app by manual test
batch 4. `observe-keyboard-up.json` is the observe JSON object from line 4 of
`scratch/i17.out` in the `mt-batch4` worktree, with the `### observe: ` prefix
removed. `plan.json` is the corresponding `i17.json` tool plan.

This is observe OUTPUT (including skeleton/context rows), not a raw iOS view
hierarchy. Raw visible and minimized keyboard captures are in `../ios-keyboard-states/`.
The tests build minimal synthetic hierarchy scaffolding from these captured
bounds; that scaffolding must not be described as a captured raw hierarchy.
