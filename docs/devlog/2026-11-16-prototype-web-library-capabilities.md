# Web library advertises the host's known capabilities

- Kind: decision
- Date: 2026-11-16
- Source: #16453
- Shaped: [Prototype web library](../how-it-works/prototype-web-library.md)

## Context

The [library plan](2026-11-03-prototype-web-library-plan.md) has the library refuse an envelope
whose `requires` names a capability it lacks, and derive `requires` for a bare spec from a bundled
gate table. The gate table (`prototypeCapabilityGates.ts`) reaches the server logger and
`node:os`, so it does not bundle for the browser. The still renderer already draws a known node
it cannot draw as a placeholder, and draws no actions at all.

## Options

- Advertise only the capabilities whose nodes the still renderer draws in full.
- Advertise every capability the host of the same release can name.
- Make the gate table browser-safe so bare specs get a derived `requires`.

## Decision

The library advertises every capability `knownPrototypeCapabilities()` names, generated into
`prototypeWebCapabilities.generated.ts`. An envelope is refused only when it needs a capability
added after the library's release. A bare spec is drawn without a capability check. Custom frame
objects wait for a browser-safe frame validator, since the frame schema needs zod.

## Consequences

- A capability added to the gate table needs the generated list regenerated; a unit test fails
  until it is.
- Envelopes are the only way to get a refusal for a spec from a newer server.
- Making the gate table browser-safe, and accepting frame objects, are separate changes.
