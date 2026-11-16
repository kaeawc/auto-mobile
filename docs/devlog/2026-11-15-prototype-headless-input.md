# Headless taps run on the host, not in a browser

- Kind: decision
- Date: 2026-11-15
- Source: #18360
- Shaped: [Headless prototype mode](../how-it-works/prototype-headless.md)

## Context

In headless mode nothing called `VirtualPrototypeDevice.dispatch`, so `awaitEvent` always timed
out, and there was no picture of the render. The issue suggested driving the exported web page in
a headless Chromium through Playwright, for taps, screenshots and node bounds.

## Options

- Drive the web page in Chromium. The page only switches views the host pre-rendered and runs no
  spec actions, so a click in it raises no prototype event. It also needs `playwright-core`, which
  is a dev dependency, as a runtime dependency, plus a browser on the host.
- Run the interaction on the host against the spec the virtual device holds, in the device
  runtime's order.

## Decision

`tapOn` and `sendKeys` run on the host in headless mode. `VirtualPrototypeInputs` finds the node
in the shown spec and plans its interaction in the device runtime's order
(`PrototypeRuntime.control` and `run`). The virtual device then delivers the events. An action the
host cannot run is refused before anything changes.

Screenshots, `tapAt` and node bounds need a rendered layout. That means a browser and moving
`playwright-core` to a runtime or optional dependency, which is a separate decision.

## Consequences

- Actions such as `request`, data writes, `platform`, timers, `scrollTo`, `setStack`, stack routes
  and params, `emit.requireValid` and repeat instances are refused on the virtual device for now.
- Headless mode still has no screenshot, `tapAt` or node bounds.
