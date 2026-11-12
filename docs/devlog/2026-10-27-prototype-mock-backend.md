# Declarative mock backend for prototypes

- Kind: decision
- Date: 2026-10-27
- Source: moved from `docs/decisions/prototype-mock-backend.md` (added in #15648)
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

Status: accepted for #14271.

## Decision

1. **Where it runs.** The daemon only. A mock backend answers `via: "host"` requests and channels
   before the egress check, in process, with no socket and no DNS lookup. An
   on-device twin of the same pure interpreter (TypeScript, Kotlin, Swift) is a later slice, so
   saved prototypes, ProtoViewer and disposable apps can run with no daemon.
2. **Addressing.** A reserved origin, `https://<backendId>.mock.automobile.invalid/...` (RFC 2606;
   the `.invalid` TLD never resolves). No spec field, no contract change and no capability: existing
   `request` and channel specs point at it. `<backendId>` is `[a-z0-9][a-z0-9-]{0,30}`.
3. **Definition.** Both the MCP `prototype` tool (`defineBackend`, `clearBackend`, `publish`,
   `backendLog`) and a sidecar mock document (`show {mock | mockPath}`, kept by `save`, shipped in
   bundles and disposable apps).
4. **State lifetime.** Session-scoped: backend state lives for the daemon session and is shared by
   every show, until `clearBackend` or session end. Opt-in `persist: true` is a later extension.

## Semantics fixed by the first slice

- `seed` is the seed of the backend's random stream (latency draws and `rate` faults), so a flaky
  checkout replays identically. It is not collection seed data; collections carry their own items.
- An unknown backend id fails the request with `network` and a message naming the id, as a host that
  does not answer would.
- The mock never proxies to the network and is not subject to the ProtoViewer egress switch.
- A channel joins a room by its URL path. Membership is per room path (`/rooms/a` and `/rooms/b` of
  one `/rooms/:roomId` definition are separate rooms), and a `timeline` runs per connection from its
  open, so every viewer of a scripted feed sees it from the start.
- A collection broadcast binds the stored item (`{item}`), not the request body, so generated ids
  reach the other devices.
- Redefining or clearing a backend closes its channels (1001) instead of moving them to the new
  definition; the device's own reconnect then joins the new backend or fails as unknown.

## Alternatives checked

| Alternative                          | Why not                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A daemon HTTP port via `adb reverse` | The egress policies refuse loopback, it adds a listening-port lifecycle, and it needs a new dependency.                                |
| A `backend` field or `via: "mock"`   | Both need a contract change and a capability gate in TypeScript, Kotlin and Swift for no capability the reserved origin does not give. |
| Express/json-server as a dependency  | A listening server again, plus a code-shaped definition. The engine is a small pure function over data, tested with fakes.             |
| `Math.random` / `crypto` directly    | The repo's single randomness primitive is `Random`; ids come from `IdGenerator`; delays from the injected `Timer`, so tests are exact. |
