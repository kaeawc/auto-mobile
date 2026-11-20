# Defer car-specific prototypes on AAOS

- Kind: decision
- Date: 2026-11-07
- Source: #16747, #14915, #14922; AAOS counterpart of #14934
- Shaped: [Automotive prototypes](../how-it-works/plat/android/automotive-prototypes.md)

## Context

#14922 shows and dismisses phone-style prototypes on Android Automotive OS (AAOS) with honest
results, but nothing car-specific renders. The question was what a prototype of an agent-authored
car app should look like on a car display.

## Options

| Option                                              | Fidelity                                                       | Spec impact                                                                                               | Behaviour while driving                                                 | Test strategy                                                               | Maintenance                                                 |
| --------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1. Phone-style prototypes sized for the car display | Low: the phone renderer laid out wide and landscape            | None: no new vocabulary                                                                                   | Unverified whether the overlay stays visible under driving restrictions | Existing renderer tests at car display sizes                                | None beyond the existing renderer                           |
| 2. Car App Library-shaped nodes in the shared spec  | Medium: list, grid, pane and navigation shapes, drawn natively | New nodes across the TS, Kotlin and Swift validators and renderers; could later back CarPlay-styled mocks | Same overlay as option 1, so equally unverified                         | New renderer tests on all three platforms                                   | Three renderers must track Car App Library template styling |
| 3. Template-only spec subset generating a host app  | High: real `androidx.car.app` templates, also on Android Auto  | A template-only subset that maps to Car App Library templates; other node kinds are refused               | The car host applies its own template restrictions to the generated app | Needs an AAOS emulator or a Desktop Head Unit to run the generated host app | New host app and its Car App Library upkeep                 |
| 4. Defer                                            | n/a                                                            | None                                                                                                      | n/a                                                                     | None                                                                        | None                                                        |

## Decision

Defer (option 4), decided by the owner on 2026-11-07 in #16747. AAOS keeps phone-style prototypes
sized for the car display, with no spec, validator or renderer changes.

## Consequences

A spec cannot target car templates or car-specific nodes on AAOS, and no follow-up implementation
issues are filed. Revisit when there is demand for car-specific prototypes.

Questions left to the owner when this is revisited:

- What counts as the demand that reopens it.
- Whether option 2 should be designed together with the CarPlay mock in
  [Defer CarPlay prototypes](2026-11-03-carplay-prototypes-deferred.md), since both would add
  template-shaped nodes to the same shared spec.
- Whether the open option 1 checks are worth measuring first: that the dismiss button clears the car
  system bars, and whether a prototype stays visible under driving restrictions.
