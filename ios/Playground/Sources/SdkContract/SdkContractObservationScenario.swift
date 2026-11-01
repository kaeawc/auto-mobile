import AutoMobileSDK
import Foundation
import os

/// One action the contract bridge's executor ran. The bridge rejects stale, unknown and
/// unsupported actions before its executor, so they never appear here.
struct ObservationHostAction: Encodable, Equatable, Sendable {
    let kind: String
    let elementId: String?
    let observationIdentity: UInt64
    let text: String?
}

/// What the observation scenario's host saw while the harness drove it (#5164 phase B).
struct ObservationHostLog: Encodable, Equatable, Sendable {
    let captures: Int
    let actions: [ObservationHostAction]
}

/// Observation slice (#5164 phase B): registers a contract `AutoMobileObservationBridge` whose
/// synthetic nodes the harness observes and acts on through the MCP tools. Node ids match
/// `OBSERVATION_NODES` in `scripts/ios/sdk-contract/observationSlice.ts`.
///
/// - `contract-save` counts taps into `contract-tap-count`'s value.
/// - `contract-email` is always focused, so sendKeys needs no XCTest focus tap; its value is
///   whatever the bridge's `insertText` and `clearText` left.
/// - `contract-hold` is under the status bar and has no visible tap area. The unsupported
///   long-press probe uses the visible `contract-save` node so it can reach bridge routing.
/// - Tapping `contract-arm-stale` arms the stale trap: from then on every capture is replaced by
///   another one as soon as the bridge has committed it, so an action the daemon resolved against
///   it is stale when it arrives.
final class SdkContractObservationHost: AutoMobileObservationProvider, AutoMobileActionExecutor,
    @unchecked Sendable
{
    static let supportedActions: Set<AutoMobileActionKind> = [.tap, .insertText, .clearText]

    private struct State {
        var captureIdentity: UInt64 = 0
        var captures = 0
        var tapCount = 0
        var email = ""
        var staleTrapArmed = false
        var actions: [ObservationHostAction] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    /// Marks the captures an invalidation makes itself, so they do not schedule another one.
    @TaskLocal static var invalidating = false
    /// No snapshot has this element, so a probe naming it never reaches the executor.
    static let probeElementId = "contract-probe-absent"
    static let invalidationAttempts = 100

    weak var bridge: AutoMobileObservationBridge?

    func captureObservation() async -> AutoMobileObservationSnapshot {
        let (snapshot, armed) = state.withLock { state -> (AutoMobileObservationSnapshot, Bool) in
            state.captureIdentity += 1
            state.captures += 1
            return (Self.snapshot(state), state.staleTrapArmed)
        }
        if armed, !Self.invalidating {
            let identity = snapshot.captureIdentity
            Task { [weak self] in
                await Self.$invalidating.withValue(true) {
                    await self?.invalidate(identity)
                }
            }
        }
        return snapshot
    }

    /// Replaces `identity` as the bridge's current observation, but only once the bridge has
    /// committed it: a recapture that committed first would leave `identity` current. The probe
    /// is rejected before the executor either way, `unknown_element` when `identity` is current
    /// and `stale_observation` when it is not yet (or no longer, when a later capture's own
    /// invalidation takes over).
    private func invalidate(_ identity: UInt64) async {
        guard let bridge else { return }
        for _ in 0 ..< Self.invalidationAttempts {
            let probe = await bridge.perform(.tap(observationIdentity: identity, elementId: Self.probeElementId))
            if probe.reason == "unknown_element" {
                _ = await bridge.observe()
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    func execute(_ action: AutoMobileAction) async -> AutoMobileActionResult {
        state.withLock { state in
            let identity = action.observationIdentity
            let id = action.targetElementId
            switch action {
            case .tap:
                state.actions.append(.init(kind: "tap", elementId: id, observationIdentity: identity, text: nil))
                if id == "contract-save" { state.tapCount += 1 }
                if id == "contract-arm-stale" { state.staleTrapArmed = true }
            case let .insertText(_, _, text):
                state.actions.append(
                    .init(kind: "insertText", elementId: id, observationIdentity: identity, text: text)
                )
                state.email += text
            case .clearText:
                state.actions.append(.init(kind: "clearText", elementId: id, observationIdentity: identity, text: nil))
                state.email = ""
            default:
                // Any other kind reaching the executor is a finding: the bridge did not declare it.
                state.actions.append(
                    .init(kind: action.kind.rawValue, elementId: id, observationIdentity: identity, text: nil)
                )
            }
        }
        return AutoMobileActionResult(status: .accepted, durationMs: 1)
    }

    func log() -> ObservationHostLog {
        state.withLock { ObservationHostLog(captures: $0.captures, actions: $0.actions) }
    }

    private static func snapshot(_ state: State) -> AutoMobileObservationSnapshot {
        let screen = SdkBounds(left: 0, top: 0, right: 390, bottom: 844)
        func node(
            _ id: String,
            _ role: String,
            _ label: String,
            _ top: Int,
            value: String? = nil
        ) -> AutoMobileObservationNode {
            AutoMobileObservationNode(
                id: id,
                role: role,
                label: label,
                value: value,
                bounds: SdkBounds(left: 24, top: top, right: 366, bottom: top + 44),
                focused: id == "contract-email"
            )
        }
        let hold = AutoMobileObservationNode(
            id: "contract-hold",
            role: "button",
            label: "Contract hold",
            bounds: SdkBounds(left: 24, top: 8, right: 160, bottom: 40)
        )
        let root = AutoMobileObservationNode(
            id: "contract-root",
            role: "group",
            label: "SDK contract",
            bounds: screen,
            children: [
                node("contract-save", "button", "Contract save", 160),
                node("contract-tap-count", "text", "Contract taps", 220, value: String(state.tapCount)),
                node("contract-email", "textField", "Contract email", 280, value: state.email),
                node("contract-arm-stale", "button", "Contract arm stale", 340),
                hold,
            ]
        )
        return AutoMobileObservationSnapshot(
            captureIdentity: state.captureIdentity,
            orientation: .portrait,
            coordinateSpace: .screen,
            bounds: screen,
            root: root,
            focusedElementId: "contract-email"
        )
    }
}

enum SdkContractObservationScenario {
    /// Registers the contract bridge; the caller keeps the host alive until the harness is done.
    static func register(
        registry: AutoMobileObservationRegistry = .shared
    ) -> SdkContractObservationHost {
        let host = SdkContractObservationHost()
        let bridge = AutoMobileObservationBridge(provider: host, executor: host)
        host.bridge = bridge
        registry.register(bridge, supportedActions: SdkContractObservationHost.supportedActions)
        return host
    }
}
