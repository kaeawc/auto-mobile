import Foundation

// Pure, UIKit-free connection protocol for the overlay agent (#10566): launch configuration,
// newline framing and the hello/auth gate. Part of the UIKit-free core target, so `swift test`
// covers it on macOS; scripts/ios/overlay-agent-build.sh compiles it into the simulator dylib
// with the UIKit sources.

/// Wire contract the host checks in `hello_result`.
enum OverlayAgentProtocol {
    /// Bump when a frame shape or the handshake changes incompatibly; the host refuses a mismatch.
    static let protocolVersion = 1
    /// Agent build version, reported for diagnostics.
    static let agentVersion = "0.1.0"
    /// Request types this agent handles, then the spec features it renders. Same-id `show_overlay`
    /// replaces the shown overlay.
    static let capabilities = [
        "show_overlay",
        "dismiss_overlay",
        "put_overlay_asset",
        "remove_overlay_asset",
        "get_overlay_status",
        anchorCapability,
    ]
    /// Positions `{type: "bounds"}` node anchors (#9316). The host refuses anchors on an agent that
    /// does not advertise it, which would draw the node at its normal position. Same name as the
    /// CtrlProxy capability.
    static let anchorCapability = "overlay_anchor_v1"
    static let portEnvironmentKey = "AUTOMOBILE_OVERLAY_PORT"
    static let tokenEnvironmentKey = "AUTOMOBILE_OVERLAY_TOKEN"
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
struct OverlayAgentConfiguration: Equatable {
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
                "\(OverlayAgentProtocol.portEnvironmentKey) is not set"
            case let .invalidPort(value):
                "\(OverlayAgentProtocol.portEnvironmentKey)=\(value) is not a port in 1...65535"
            case .missingToken:
                "\(OverlayAgentProtocol.tokenEnvironmentKey) is not set"
            case .tokenTooShort:
                "\(OverlayAgentProtocol.tokenEnvironmentKey) is shorter than \(OverlayAgentProtocol.minimumTokenLength) characters"
            }
        }
    }

    /// The host allocates the port, so `0` (an OS-chosen port it could not learn) is rejected.
    static func from(environment: [String: String]) -> Result<OverlayAgentConfiguration, Failure> {
        guard let rawPort = environment[OverlayAgentProtocol.portEnvironmentKey] else {
            return .failure(.missingPort)
        }
        guard let port = UInt16(rawPort), port > 0 else { return .failure(.invalidPort(rawPort)) }
        guard let token = environment[OverlayAgentProtocol.tokenEnvironmentKey], !token.isEmpty else {
            return .failure(.missingToken)
        }
        guard token.count >= OverlayAgentProtocol.minimumTokenLength else { return .failure(.tokenTooShort) }
        return .success(OverlayAgentConfiguration(port: port, token: token))
    }
}

/// Splits a byte stream into newline-terminated frames, bounding how much it buffers.
struct OverlayLineFramer {
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
/// launch token; anything else closes the connection before any overlay data or control is
/// exchanged.
struct OverlayConnectionGate {
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
        /// An authenticated request for the overlay handler.
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

    init(token: String, capabilities: [String] = OverlayAgentProtocol.capabilities) {
        self.token = token
        self.capabilities = capabilities
    }

    var isAuthenticated: Bool {
        state == .authenticated
    }

    /// Frame size limit for the current state.
    var frameLimit: Int {
        state == .authenticated ? OverlayAgentProtocol.maxFrameBytes : OverlayAgentProtocol.maxHelloBytes
    }

    mutating func receive(line: Data) -> Action {
        guard state != .closed else { return .ignore }
        guard !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) else { return .ignore }
        let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        guard state == .authenticated else { return authenticate(object) }
        guard let object else {
            return .rejectMalformed([
                "type": "overlay_result",
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
            "agentVersion": OverlayAgentProtocol.agentVersion,
            "protocolVersion": OverlayAgentProtocol.protocolVersion,
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
