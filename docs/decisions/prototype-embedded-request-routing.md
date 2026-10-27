# Request routing for embedded prototype renderers

Status: accepted for #13721 (part of the embeddable-renderer epic #13720). Owner decision recorded on
the issue, 2026-10-20.

## Problem

A prototype `request` action defaults to `via: "host"`. A host request is carried by the AutoMobile
daemon, and an app that embeds the renderer has no daemon:

- iOS: `PrototypeRequestDriver` fails the request as `network` with "No AutoMobile host is
  connected".
- Android: `PrototypeHttpClients.forSavedPrototype` refuses it with `HOST_UNAVAILABLE_MESSAGE`.

Most agent-authored specs omit `via`, so most prototypes that use the network would break when
embedded.

## Decision

One policy, identical on Android and iOS.

1. **Device route.** The embedding app supplies an HTTP client for `via: "device"`. Android: an
   `OkHttpClient`, wrapped as the existing `RetrofitPrototypeHttpClient`. iOS: a `URLSession`, wrapped
   as `PrototypeURLSessionClient` (URLSession, not Alamofire; see #12518).
2. **Default for `via: "host"` is the device client.** When the embedding app supplies no host
   handler, a `via: "host"` request runs on the device-side client under the same egress rules that
   apply to `via: "device"`. Specs authored against the daemon keep working unchanged when embedded.
3. **Optional host-supplied request handler.** The embedding app may pass a handler that takes over
   `request` actions. That is where an app adds authentication, uses its own API stack, or serves
   canned fixtures. When a handler is present it receives the request instead of the device client.
4. **Same egress rules.** The device client used as the default follows the same egress rules as the
   other device-side prototype clients (the ProtoViewer and CtrlProxy device route).
5. **One shared fixture.** A single fixture is exercised on both platforms: the same spec and the
   same request outcome produce the same outcome event on Android and iOS.

## Alternatives considered

| Alternative                                                                      | Why not                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refuse `via: "host"` when no host handler is supplied                            | Safe, but breaks the common case: most specs omit `via`, so most network prototypes would fail embedded. Every embedder would have to write a handler before anything works. |
| Require the embedder to rewrite `via` in specs                                   | Specs are authored by agents against the daemon. Rewriting them in the app duplicates spec knowledge in every embedding app.                                                 |
| Route `via: "host"` to the daemon when one is reachable, device client otherwise | Behaviour would change with the environment, and an embedded app has no way to know which route ran. The policy must not depend on whether a daemon exists.                  |
| Alamofire as the iOS client                                                      | Owner chose `URLSession` for #12518. `PrototypeURLSessionClient` needs no new dependency.                                                                                    |

## Out of scope

- ProtoViewer's egress filter and the global network switch (#13622). Those apply to imported
  prototypes whose author is not the app. An embedding app ships its own specs and owns its network
  policy; the handler hook is how it expresses that policy.

## Consequences

- Android and iOS runtimes accept an optional host handler. When absent they follow the default
  above.
- The two shared outcomes (device route and defaulted host route) are covered by unit tests with a
  fake client on both platforms; no test touches the network.
- The follow-up slices are the Android public Compose API (#13725) and the iOS embeddable
  controller (#13726). Both depend on this decision.
