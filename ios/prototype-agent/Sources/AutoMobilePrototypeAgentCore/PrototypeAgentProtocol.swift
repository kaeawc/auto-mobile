import Foundation

// Pure, UIKit-free connection protocol for the prototype agent (#10566): launch configuration,
// newline framing and the hello/auth gate. Part of the UIKit-free core target, so `swift test`
// covers it on macOS; scripts/ios/prototype-agent-build.sh compiles it into the simulator dylib
// with the UIKit sources.

/// Wire contract the host checks in `hello_result`.
enum PrototypeAgentProtocol {
    /// Bump when a frame shape or the handshake changes incompatibly; the host refuses a mismatch.
    static let protocolVersion = 1
    /// Agent build version, reported for diagnostics.
    static let agentVersion = "0.1.0"
    /// Request types this agent handles, then the spec features it renders. Same-id `show_prototype`
    /// replaces the shown prototype.
    static let capabilities = [
        "show_prototype",
        "dismiss_prototype",
        "put_prototype_asset",
        "remove_prototype_asset",
        "get_prototype_status",
        showInPlaceCapability,
        anchorCapability,
        hideForCaptureRequest,
        restoreAfterCaptureRequest,
        screenshotHideCapability,
        inspectCapability,
        themeModesCapability,
        appearanceCapability,
    ]
    /// A same-id `show_prototype` replaces the prototype in place keeping pager pages, and
    /// `reset: true` starts it fresh. Same name as the CtrlProxy capability; the host refuses
    /// `reset` on an agent that does not advertise it.
    static let showInPlaceCapability = "prototype_show_in_place_v1"
    /// Positions `{type: "bounds"}` node anchors (#9316). The host refuses anchors on an agent that
    /// does not advertise it, which would draw the node at its normal position. Same name as the
    /// CtrlProxy capability.
    static let anchorCapability = "prototype_anchor_v1"
    /// Hides the prototype window so the host's simulator screenshot shows the app alone (#9305).
    /// The agent restores on its own after `deadlineMs`, so a cancelled host cannot leave the
    /// prototype hidden.
    static let hideForCaptureRequest = "hide_for_capture"
    /// Releases one `hide_for_capture` hold by the `token` its reply carried (no token releases
    /// every hold); the prototype returns with the last hold. `restored: false` means that hold was
    /// no longer live (it expired), so the capture may have shown the prototype.
    static let restoreAfterCaptureRequest = "restore_after_capture"
    /// Advertised when both capture requests are handled; same name as the CtrlProxy capability.
    static let screenshotHideCapability = "screenshot_hide_prototype_v1"
    /// `get_prototype_status` replies with `status.lastSequence` and `status.visible` besides the
    /// state, which is what the host's `inspect` adopts. An older agent answers status without
    /// them, so the host refuses `inspect` unless this is advertised.
    static let inspectCapability = "prototype_inspect_v1"
    /// Draws the per-mode spec forms (#11220): `{light, dark}` colour and image pairs, role names in
    /// gradient stops and scrims, and `theme.colors.light` / `theme.colors.dark`. The host refuses a
    /// spec that uses one on an agent that does not advertise it. Same name as the CtrlProxy
    /// capability.
    static let themeModesCapability = "prototype_theme_modes_v1"
    /// Appearance (#11222): `show_prototype` takes `appearance` (`device`, `light` or `dark`), the
    /// show result and `get_prototype_status` report `appearance: {mode, source, deviceDark}`, and
    /// any change of the shown prototype's mode (the device flipping, or state moving the inferred
    /// background) re-themes it and pushes one `appearance_changed` event. The host sends `appearance` only to an agent
    /// that advertises
    /// this. Same name as the CtrlProxy capability.
    static let appearanceCapability = "prototype_appearance_v1"
    static let portEnvironmentKey = "AUTOMOBILE_PROTOTYPE_PORT"
    static let tokenEnvironmentKey = "AUTOMOBILE_PROTOTYPE_TOKEN"
    /// Shortest token the agent accepts, so a stray or empty value cannot open the server.
    static let minimumTokenLength = 16
    /// An unauthenticated connection may send at most this much before its `hello` line ends.
    static let maxHelloBytes = 4096
    /// Upper bound for one authenticated frame (a base64 screenshot asset fits comfortably).
    static let maxFrameBytes = 64 << 20
    /// Seconds an unauthenticated connection may stay open without sending `hello`.
    static let helloTimeoutSeconds = 5.0
}

/// Per-launch settings the host passes through `SIMCTL_CHILD_*` environment variables.
struct PrototypeAgentConfiguration: Equatable {
    let port: UInt16
    let token: String

    enum Failure: Error, Equatable, CustomStringConvertible {
        case missingPort
        case invalidPort(String)
        case missingToken
        case tokenTooShort

        var description: String {
            switch self {
            case .missingPort:
                "\(PrototypeAgentProtocol.portEnvironmentKey) is not set"
            case let .invalidPort(value):
                "\(PrototypeAgentProtocol.portEnvironmentKey)=\(value) is not a port in 1...65535"
            case .missingToken:
                "\(PrototypeAgentProtocol.tokenEnvironmentKey) is not set"
            case .tokenTooShort:
                "\(PrototypeAgentProtocol.tokenEnvironmentKey) is shorter than \(PrototypeAgentProtocol.minimumTokenLength) characters"
            }
        }
    }

    /// The host allocates the port, so `0` (an OS-chosen port it could not learn) is rejected.
    static func from(environment: [String: String]) -> Result<PrototypeAgentConfiguration, Failure> {
        guard let rawPort = environment[PrototypeAgentProtocol.portEnvironmentKey] else {
            return .failure(.missingPort)
        }
        guard let port = UInt16(rawPort), port > 0 else { return .failure(.invalidPort(rawPort)) }
        guard let token = environment[PrototypeAgentProtocol.tokenEnvironmentKey], !token.isEmpty else {
            return .failure(.missingToken)
        }
        guard token.count >= PrototypeAgentProtocol.minimumTokenLength else { return .failure(.tokenTooShort) }
        return .success(PrototypeAgentConfiguration(port: port, token: token))
    }
}

/// Splits a byte stream into newline-terminated frames, bounding how much it buffers.
struct PrototypeLineFramer {
    struct FrameTooLarge: Error, Equatable {
        let limit: Int
    }

    private(set) var buffered = Data()

    mutating func append(_ data: Data) {
        buffered.append(data)
    }

    /// The next complete line (without its newline), `nil` when none is buffered yet, or an
    /// error once a line exceeds `limit` bytes. Callers pass the limit for the current
    /// connection state, so the hello line is held to a much smaller bound than later frames.
    mutating func nextLine(limit: Int) -> Result<Data?, FrameTooLarge> {
        guard let newline = buffered.firstIndex(of: 0x0A) else {
            return buffered.count > limit ? .failure(FrameTooLarge(limit: limit)) : .success(nil)
        }
        let line = Data(buffered[buffered.startIndex ..< newline])
        guard line.count <= limit else { return .failure(FrameTooLarge(limit: limit)) }
        buffered = Data(buffered[buffered.index(after: newline)...])
        return .success(line)
    }
}

/// Per-connection auth state machine. The first frame must be `{type: "hello", token}` with the
/// launch token; anything else closes the connection before any prototype data or control is
/// exchanged.
struct PrototypeConnectionGate {
    enum State: Equatable {
        case awaitingHello
        case authenticated
        case closed
    }

    enum CloseReason: Equatable {
        case notJSON
        case notHello
        case badToken
        case frameTooLarge
        case helloTimeout
    }

    enum Action {
        /// Authenticated: send this `hello_result`, then accept requests.
        case helloAccepted([String: Any])
        /// An authenticated request for the prototype handler.
        case dispatch([String: Any])
        /// An authenticated line that is not a JSON object; answer with this error result.
        case rejectMalformed([String: Any])
        /// Close the connection without replying.
        case close(CloseReason)
        /// Nothing to do (a blank line, or a line after the gate closed).
        case ignore
    }

    private let token: String
    /// Request types advertised in `hello_result`; the host refuses to send anything else.
    private let capabilities: [String]
    private(set) var state: State = .awaitingHello

    init(token: String, capabilities: [String] = PrototypeAgentProtocol.capabilities) {
        self.token = token
        self.capabilities = capabilities
    }

    var isAuthenticated: Bool {
        state == .authenticated
    }

    /// Frame size limit for the current state.
    var frameLimit: Int {
        state == .authenticated ? PrototypeAgentProtocol.maxFrameBytes : PrototypeAgentProtocol.maxHelloBytes
    }

    mutating func receive(line: Data) -> Action {
        guard state != .closed else { return .ignore }
        guard !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) else { return .ignore }
        let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        guard state == .authenticated else { return authenticate(object) }
        guard let object else {
            return .rejectMalformed([
                "type": "prototype_result",
                "requestId": NSNull(),
                "success": false,
                "error": "Request is not a JSON object",
            ])
        }
        return .dispatch(object)
    }

    /// Close for a reason detected outside a frame (oversized buffer, hello deadline).
    mutating func fail(_ reason: CloseReason) -> Action {
        guard state != .closed else { return .ignore }
        state = .closed
        return .close(reason)
    }

    private mutating func authenticate(_ object: [String: Any]?) -> Action {
        guard let object else { return fail(.notJSON) }
        guard object["type"] as? String == "hello" else { return fail(.notHello) }
        guard let presented = object["token"] as? String, Self.constantTimeEquals(presented, token) else {
            return fail(.badToken)
        }
        state = .authenticated
        return .helloAccepted([
            "type": "hello_result",
            "agentVersion": PrototypeAgentProtocol.agentVersion,
            "protocolVersion": PrototypeAgentProtocol.protocolVersion,
            "capabilities": capabilities,
        ])
    }

    /// Compares every byte so the time taken does not reveal how much of a guess matched.
    static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8)
        let right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
