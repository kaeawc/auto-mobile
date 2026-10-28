# iOS SDK host-integration profile

The iOS SDK never swizzles or replaces an app-owned delegate, so it captures only what the host
app registers. This document defines one registration path per adapter family, who owns each
lifecycle, and the capability descriptors that tell a host and AutoMobile what is covered. Network
transports are implemented. WKWebView and navigation adapters follow the same profile and are
tracked in #15693.

## Capability descriptors

The SDK reports each family as an `SdkCapabilityDescriptor` (`ios/sdk-wire`). It has the same
`id` / `state` / `reason` shape and the same `SdkCapabilityState` spelling as the Android SDK's
`SdkCapabilityDocument`, so one host-side parser reads both platforms. A state the reader does not
know decodes as `UNKNOWN` on both platforms. Transport descriptors add `faultEnforcement`, which
Android-shaped parsers drop.

| Profile term | `state` | `reason` | Meaning |
|---|---|---|---|
| active | `SUPPORTED` | — | registered and capturing |
| host opt-in | `DISABLED` | `HOST_OPT_IN` | supported, but the host has not registered it |
| capture off | `DISABLED` | `NETWORK_CAPTURE_DISABLED` | registered, network capture switched off at runtime |
| not started | `NOT_INITIALIZED` | `NETWORK_CAPTURE_NOT_INITIALIZED` | SDK disabled, or started with `enableNetworkCapture = false` |
| unsupported | `UNSUPPORTED` | `NO_ADAPTER` | no adapter exists; manual `recordRequest` only |

`faultEnforcement` is `ENFORCED` when the SDK applies a matched fault rule itself, `EVALUATE_ONLY`
when it returns a decision the host must apply, and `NONE` when no rule can take effect. Only a
`SUPPORTED` transport in a DEBUG build reports anything other than `NONE`, because fault rules
exist only in DEBUG builds.

An unregistered family is never `SUPPORTED`: missing registration reads as host opt-in rather
than full coverage. `SUPPORTED` means the host registered the family. For the adapter families it
still depends on the host forwarding every callback; the SDK cannot detect a callback the host
never forwards.

The host reads the descriptors with `AutoMobileNetwork.shared.transportCapabilities()`. It returns
one descriptor per `HostTransport`, in declaration order.

## Network transports

| Family | Registration | Capture path | `faultEnforcement` when active |
|---|---|---|---|
| Default and custom `URLSession` (`network.transport.urlsession`) | `registerURLSession(configuration)` before `URLSession(configuration:)` | SDK `URLProtocol` | `ENFORCED` |
| Background `URLSession` (`network.transport.urlsession.background`) | `registerURLSession(backgroundConfiguration)`, then forward delegate callbacks to `registration.adapter` | `URLSessionNetworkCaptureAdapter` | `EVALUATE_ONLY` |
| `URLSessionWebSocketTask` (`network.transport.websocket`) | `registerWebSocket()`, then forward sent and received frames | `WebSocketNetworkCaptureAdapter` | `EVALUATE_ONLY` |
| `NWConnection` (`network.transport.nwconnection`) | `registerNWConnection()`, then forward state, send and receive callbacks | `NWConnectionNetworkCaptureAdapter` | `EVALUATE_ONLY` |
| Anything else (`network.transport.other`) | none | `recordRequest` | `NONE` |

Fault enforcement on the three adapter transports is #5163. It changes their `faultEnforcement`,
not their registration.

### Ownership and lifecycle

- **Configuration, not session.** A `URLSession` copies its configuration when it is created, so
  registration takes the configuration. `registerURLSession` puts the SDK `URLProtocol` first in
  `protocolClasses`. It changes nothing else, and the session delegate stays the host's.
- **Background sessions** ignore `protocolClasses`. `registerURLSession` detects them by their
  `identifier`, leaves the configuration unchanged and returns mode `delegateForwarding` with an
  adapter. The host keeps its own delegate and calls the adapter from it.
- **Idempotency.** Each registration call may be repeated. The protocol is installed once per
  configuration; registration state is a set of families, so a repeat does not change the
  descriptors. A `URLProtocol` registration returns no adapter, so the same request cannot also be
  recorded through the delegate path.
- **Adapters** are stateless forwarders over one `NetworkCaptureRecorder`. Use one adapter per
  task or connection. A repeated call returns a fresh adapter; forwarding the same callback to two
  adapters records it twice.
- **Duplicate completion.** The `URLProtocol` marks each request it handles so it never
  re-enters. The recorder drops a second terminal callback (`didComplete`, `didFail`,
  `didCancel`) for the same request id.
- **Threading.** Registration and every adapter method may be called from any queue. State is held
  in `OSAllocatedUnfairLock`, and nothing calls out while holding it. Events carry a sequence
  number, so ordering survives delivery from several queues.
- **Redaction** is the recorder's: credential headers are replaced with `<redacted>`, and bodies
  are captured only when enabled and within the byte bound. See the
  [network capture wire contract](network-capture-wire-contract.md).
- **Teardown.** There is no unregister call. A `URLSession` keeps its copied configuration, so
  invalidate the session to stop capture. Adapters hold no resources: drop them with the task or
  connection. Disabling capture reports `DISABLED` / `NETWORK_CAPTURE_DISABLED`. `AutoMobileSDK`
  reset clears the registered families.

## WKWebView and navigation (#15693)

These families follow the same rules: one registration call, no delegate replacement, and a
descriptor that is `DISABLED` / `HOST_OPT_IN` until registered.

| Family | Planned registration | Ownership notes |
|---|---|---|
| WKWebView | register a web view with the bridge, which adds only a script message handler and user script | `AutoMobileWebViewBridge.attach(to:)` currently sets `navigationDelegate`; the registration path must instead take navigation callbacks forwarded from the host's delegate |
| UIKit | register once, then call the push, pop, presentation, tab and split hooks from the host's delegates | no swizzling; hooks resolve the scene on the main thread |
| SwiftUI | register once, then use `.trackNavigation()` or the `track*` calls | one active flag per adapter |
| Deep links | register once, then call `record` from the host's URL handler | the host owns URL dispatch |
| Custom routers | register once, then call `record` per completed transition | events are dropped until the transition completes |

The navigation adapters share one hub. Registration must not reset a redactor another adapter
installed.

## Fixture

The Playground app's SDK contract screens (#5164) register through this API. They are the
reference integration and prove each registered transport emits exactly one ordered lifecycle
stream.
