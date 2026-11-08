import Foundation
import XCTest

@MainActor
final class TVCommandRouter {
    private let application: XCUIApplication
    private var lastFocusedField: TVFocusedField?

    init(application: XCUIApplication) {
        self.application = application
    }

    private struct Envelope: Decodable {
        let type: String
        let requestId: String?
        /// Optional hint naming the app in front; the runner probes first-party apps otherwise.
        let bundleId: String?
    }

    /// Resolve the frontmost app per command; the host app is not necessarily in front.
    private func target(requested: String?) -> (app: XCUIApplication, packageName: String) {
        let hostId = "dev.jasonpearson.automobile.ctrlproxy.tv"
        let hostState = Int(application.state.rawValue)
        guard hostState != TVTargetResolver.foregroundState else { return (application, hostId) }
        let candidates = TVTargetResolver.candidateBundleIds(requested: requested).map {
            (bundleId: $0, state: Int(XCUIApplication(bundleIdentifier: $0).state.rawValue))
        }
        switch TVTargetResolver.resolve(hostState: hostState, candidates: candidates) {
        case .host: return (application, hostId)
        case let .app(bundleId): return (XCUIApplication(bundleIdentifier: bundleId), bundleId)
        case .home:
            let homeId = TVTargetResolver.homeScreenBundleId
            return (XCUIApplication(bundleIdentifier: homeId), homeId)
        }
    }

    func handle(_ data: Data) -> Data {
        var requestId: String?
        do {
            let decoder = JSONDecoder()
            let envelope = try decoder.decode(Envelope.self, from: data)
            requestId = envelope.requestId
            guard TVCommandPolicy.supports(envelope.type) else {
                return try JSONEncoder().encode(WebSocketResponse.error(
                    type: "error", requestId: requestId,
                    error: "Command '\(envelope.type)' is unsupported on tvOS."
                ))
            }
            switch envelope.type {
            case "request_hierarchy":
                let request = try decoder.decode(RequestHierarchy.self, from: data)
                let resolved = target(requested: envelope.bundleId)
                let snapshot = try resolved.app.snapshot()
                let tree = sketch(snapshot)
                lastFocusedField = TVTextEntryPolicy.rememberedField(in: tree, previous: lastFocusedField)
                let entry = TVTextEntryPolicy.resolve(
                    root: tree, hasFocusedKeyboard: TVTextEntryPolicy.hasFocusedKeyboard(tree),
                    lastFocusedField: lastFocusedField
                )
                return try JSONEncoder().encode(HierarchyUpdateResponse(
                    requestId: request.requestId,
                    data: ViewHierarchy(
                        packageName: resolved.packageName,
                        hierarchy: element(snapshot, entry: entry),
                        screenWidth: ElementBounds.clampedInt(snapshot.frame.width),
                        screenHeight: ElementBounds.clampedInt(snapshot.frame.height)
                    )
                ))
            case "request_press_button":
                let request = try decoder.decode(RequestPressButton.self, from: data)
                guard let button = TVRemoteButton(rawValue: request.action) else {
                    throw CommandError.invalidParameter("action", request.action)
                }
                // This runner does not advertise frame-context validation.
                guard request.frameContext == nil else {
                    throw CommandError.invalidParameter("frameContext", "unsupported on tvOS")
                }
                let startTime = Date()
                if button == .select {
                    let resolved = target(requested: envelope.bundleId)
                    // Best effort: a failed snapshot must not prevent remote input.
                    if let snapshot = try? resolved.app.snapshot() {
                        lastFocusedField = TVTextEntryPolicy.rememberedField(
                            in: sketch(snapshot), previous: lastFocusedField
                        )
                    }
                }
                press(button)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "press_button_result", requestId: requestId,
                    totalTimeMs: Int64(Date().timeIntervalSince(startTime) * 1000)
                ))
            case "request_append_text":
                let request = try decoder.decode(RequestAppendText.self, from: data)
                // This runner does not advertise frame-context validation.
                guard request.frameContext == nil else {
                    throw CommandError.invalidParameter("frameContext", "unsupported on tvOS")
                }
                let startTime = Date()
                let resolved = target(requested: envelope.bundleId)
                let snapshot = try resolved.app.snapshot()
                guard TVTextEntryPolicy.hasFocusedKeyboard(sketch(snapshot)) else {
                    throw CommandError.invalidParameter("text", "no focused text input")
                }
                resolved.app.typeText(request.text)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: ResponseType.appendTextResult.rawValue, requestId: request.requestId,
                    totalTimeMs: Int64(Date().timeIntervalSince(startTime) * 1000)
                ))
            case "request_screenshot":
                let screenshot = XCUIScreen.main.screenshot()
                return try JSONEncoder().encode(ScreenshotResponse(
                    requestId: requestId,
                    data: screenshot.pngRepresentation.base64EncodedString(),
                    format: "png",
                    rotation: nil,
                    frameContext: nil
                ))
            default:
                // The allowlist is exhaustive; do not silently execute newly advertised commands.
                throw CommandError.unknownCommand(envelope.type)
            }
        } catch {
            let response = WebSocketResponse.error(
                type: "error", requestId: requestId, error: error.localizedDescription,
                errorCode: (error as? CommandError)?.wireCode
            )
            // Only strings and finite timestamps are encoded; keep a structured error even
            // if Foundation unexpectedly rejects that envelope.
            return (try? JSONEncoder().encode(response))
                ?? Data(#"{"type":"error","success":false,"error":"Response encoding failed"}"#.utf8)
        }
    }

    private func sketch(_ snapshot: any XCUIElementSnapshot) -> TVNodeSketch {
        TVNodeSketch(
            elementType: Int(snapshot.elementType.rawValue), identifier: snapshot.identifier,
            label: snapshot.label, value: snapshot.value as? String, placeholder: snapshot.placeholderValue,
            hasFocus: snapshot.hasFocus, children: snapshot.children.map { sketch($0) }
        )
    }

    private func element(
        _ snapshot: any XCUIElementSnapshot, entry: TVKeyboardEntry?, path: [Int] = []
    ) -> UIElementInfo {
        let entryOverride = entry.flatMap { $0.path == path ? $0 : nil }
        return UIElementInfo(
            text: entryOverride?.text ?? TVElementText.text(
                label: snapshot.label,
                value: snapshot.value as? String,
                placeholder: snapshot.placeholderValue,
                isTextInput: [.textField, .secureTextField, .searchField, .textView].contains(snapshot.elementType),
                isSecure: TVSecureField.isSecure(
                    elementType: Int(snapshot.elementType.rawValue), identifier: snapshot.identifier,
                    label: snapshot.label, placeholder: snapshot.placeholderValue
                )
            ),
            resourceId: entryOverride == nil ? snapshot.identifier : entryOverride?.resourceId,
            className: entryOverride?.className ?? String(snapshot.elementType.rawValue),
            bounds: ElementBounds(clamping: snapshot.frame),
            enabled: String(snapshot.isEnabled),
            focused: String(entryOverride?.focused ?? snapshot.hasFocus),
            selected: String(snapshot.isSelected),
            node: snapshot.children.enumerated().map { index, child in
                element(child, entry: entry, path: path + [index])
            }
        )
    }

    private func press(_ button: TVRemoteButton) {
        let remote = XCUIRemote.shared
        switch button {
        case .moveUp: remote.press(.up)
        case .down: remote.press(.down)
        case .left: remote.press(.left)
        case .right: remote.press(.right)
        case .select: remote.press(.select)
        case .menu: remote.press(.menu)
        case .home: remote.press(.home)
        case .playPause: remote.press(.playPause)
        }
    }
}
