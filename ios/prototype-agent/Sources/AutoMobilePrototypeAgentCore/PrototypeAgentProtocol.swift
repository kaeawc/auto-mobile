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
        patchRequest,
        patchCapability,
        showInPlaceCapability,
        anchorCapability,
        hideForCaptureRequest,
        restoreAfterCaptureRequest,
        screenshotHideCapability,
        inspectCapability,
        themeModesCapability,
        flowGridCapability,
        pagerOptionsCapability,
        appearanceCapability,
        windowChromeCapability,
        iconSfSymbolsCapability,
        dataModelCapability,
        dataActionsCapability,
        networkCapability,
        networkDeviceCapability,
        textFieldOptionsCapability,
        gesturesCapability,
        swipeActionsCapability,
        textFieldActionsCapability,
        carouselCapability,
        chartCapability,
        PrototypeLazyList.capability,
        loadingStatesCapability,
        stylePolishV2Capability,
        textFieldLeadingIconCapability,
        refreshCapability,
        searchBarCapability,
        richTextCapability,
        linkifyCapability,
        menusCapability,
        stackCapability,
        stackTransitionsCapability,
        emitContextCapability,
        checksCapability,
        identifierTestTagOnlyCapability,
        bottomSheetDragCapability,
        clearStorageRequest,
        storageCapability,
        timersCapability,
        "prototype_platform_v1",
        "prototype_platform_device_v1",
        advanceClockRequest,
    ]
    /// A same-id `show_prototype` replaces the prototype in place keeping pager pages and stack paths, and
    /// `reset: true` starts it fresh. Same name as the CtrlProxy capability; the host refuses
    /// `reset` on an agent that does not advertise it.
    static let showInPlaceCapability = "prototype_show_in_place_v1"
    /// Stack paths, four navigation actions, screen_changed and left-edge Back (#12068).
    static let stackCapability = "prototype_stack_v1"
    static let stackTransitionsCapability = "prototype_stack_transitions_v1"
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
    static let stylePolishV2Capability = "prototype_style_polish_v2"
    /// Eager wrapping flow and equal-width spanning grid containers (#12070).
    static let flowGridCapability = "prototype_flow_grid_v1"
    /// Draws pager axis, pageSpacing, peek and pageSize natively. The host refuses a spec that
    /// uses one on an agent that does not advertise it. Same name as the CtrlProxy capability.
    static let pagerOptionsCapability = "prototype_pager_options_v1"
    /// Appearance (#11222): `show_prototype` takes `appearance` (`device`, `light` or `dark`), the
    /// show result and `get_prototype_status` report `appearance: {mode, source, deviceDark}`, and
    /// any change of the shown prototype's mode (the device flipping, or state moving the inferred
    /// background) re-themes it and pushes one `appearance_changed` event. The host sends `appearance` only to an agent
    /// that advertises
    /// this. Same name as the CtrlProxy capability.
    static let appearanceCapability = "prototype_appearance_v1"
    /// Fullscreen `window.chrome` (#12064): `none` (default) fills the window with a hidden and
    /// accessible escape; `bar` reserves the host dismiss bar. Same name as the CtrlProxy capability.
    static let windowChromeCapability = "prototype_window_chrome_v1"
    /// Read-only data (#11673): resolves path repeats, authored text and data conditions once per
    /// show before repeat expansion. Status reports the shown data alongside state.
    static let checksCapability = "prototype_checks_v1"
    static let dataModelCapability = "prototype_data_model_v1"
    /// `setData`, `appendData` and `removeData` change `/data` from a tap and report each write as a
    /// `change` event named for the `/data/...` path with `{op, value?, revision}` (#12519). Same name
    /// as the CtrlProxy capability; the host refuses a spec using one on an agent without it.
    static let dataActionsCapability = "prototype_data_actions_v1"
    /// The `request` action (#12529): host-proxied calls (`via: "host"`, the default) through
    /// `prototype_request` / `prototype_response` frames, and the `/data`, `__meta`, `statusKey` and
    /// `prototype_request` event semantics of `applyPrototypeRequestOutcome`. Same name as the CtrlProxy
    /// capability.
    static let networkCapability = "prototype_network_v1"
    /// `via: "device"`: the agent makes the call itself through its own HTTP client. Same name as the
    /// CtrlProxy capability.
    static let networkDeviceCapability = "prototype_network_device_v1"
    /// Text field options (#12066): keyboard, secure and multiline input, drawn labels and chrome,
    /// supporting text and a UTF-16 length limit with counter. Same name as the CtrlProxy capability.
    static let textFieldOptionsCapability = "prototype_text_field_options_v1"
    /// Long press and double tap action lists on generic nodes, matching CtrlProxy (#12065).
    static let gesturesCapability = "prototype_gestures_v1"
    /// Swipe-revealed row actions with accessibility actions (#12065).
    static let swipeActionsCapability = "prototype_swipe_actions_v1"
    /// Text field `trailingIcon`, `imeAction` and `onSubmit` (#12066).
    static let textFieldActionsCapability = "prototype_text_field_actions_v1"
    /// The `carousel` node and the pager `indicator` option (#12071).
    static let carouselCapability = "prototype_carousel_v1"
    /// The `chart` node (line, area, bar and ring over `/data` arrays) drawn with Swift Charts (#14679).
    static let chartCapability = "prototype_chart_v1"
    /// `{data, empty}` conditions and style `shimmer` on box, row, column and card (#14207, #14689).
    static let loadingStatesCapability = "prototype_loading_states_v1"
    /// Text field `leadingIcon` drawn as an SF Symbol (#12066).
    static let textFieldLeadingIconCapability = "prototype_text_field_leading_icon_v1"
    /// Pull-to-refresh on a vertical scroll bound to a boolean state key (#12065).
    static let refreshCapability = "prototype_refresh_v1"
    /// Drawn search field with authored expansion, submit actions and in-window results (#12069).
    static let searchBarCapability = "prototype_search_bar_v1"
    /// Styled text runs with optional inline actions.
    static let richTextCapability = "prototype_rich_text_v1"
    /// Text nodes turn mentions, hashtags and URLs into links that run `linkify.onTap` (#14233).
    static let linkifyCapability = "prototype_linkify_v1"
    /// In-window menus and exposed select option lists.
    static let menusCapability = "prototype_menus_v1"
    // ORCHESTRATOR-CHOSEN gate; fold into PROTOTYPE_SPEC_CAPABILITY_GATES when it lands
    static let emitContextCapability = "prototype_emit_context_v1"
    /// Draws icons from schemas/prototype-ios-icon-symbols.json and honours filled/outlined
    /// icon variants where the table has those forms.
    static let iconSfSymbolsCapability = "prototype_icon_sf_symbols_v1"
    /// Node and composite-part accessibility identifiers use only `testTag`, as on Android.
    static let identifierTestTagOnlyCapability = "prototype_identifier_test_tag_only_v1"
    /// Bottom sheets drag between detents and optionally dismiss on a downward swipe.
    static let bottomSheetDragCapability = "prototype_bottom_sheet_drag_v1"
    /// Persisted `storage` (#12526): the spec's `storage` block is restored on a show and saved after
    /// writes, `get_prototype_status` reports `storage`, and `clear_prototype_storage` is handled.
    /// Same name as the CtrlProxy capability; the host refuses `storage` on an agent without it.
    static let storageCapability = "prototype_storage_v1"
    /// Wipes the values stored for `{id}`; the reply carries `cleared`, the number of keys removed. Listed
    /// beside `storageCapability` because the host checks request types against `capabilities`.
    static let clearStorageRequest = "clear_prototype_storage"
    static let timersCapability = "prototype_timers_v1"
    static let advanceClockRequest = "advance_prototype_clock"
    /// Atomic in-place `/data`, `/state` and `replaceNode` patches with revisions and state conflicts
    /// (#11675). Same name as the CtrlProxy capability; the host sends `patch_prototype` only to an agent
    /// that advertises it.
    static let patchCapability = "prototype_patch_v1"
    static let patchRequest = "patch_prototype"
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
        case hostBusy
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

    init(token: String, capabilities: [String] = PrototypeAgentProtocol.advertisedCapabilities()) {
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
