import Foundation
import XCTest

@MainActor
final class TVCommandRouter {
    private let application: XCUIApplication

    init(application: XCUIApplication) {
        self.application = application
    }

    private struct Envelope: Decodable {
        let type: String
        let requestId: String?
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
                let snapshot = try application.snapshot()
                return try JSONEncoder().encode(HierarchyUpdateResponse(
                    requestId: request.requestId,
                    data: ViewHierarchy(
                        packageName: "dev.jasonpearson.automobile.ctrlproxy.tv",
                        hierarchy: element(snapshot),
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
                press(button)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "press_button_result", requestId: requestId, totalTimeMs: 0
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

    private func element(_ snapshot: any XCUIElementSnapshot) -> UIElementInfo {
        // Translate the captured spike's frame/id/type/hasFocus/enabled/selected fields into
        // the existing hierarchy wire model. Focus is observed, never assigned directly.
        UIElementInfo(
            text: snapshot.label,
            resourceId: snapshot.identifier,
            className: String(snapshot.elementType.rawValue),
            bounds: ElementBounds(clamping: snapshot.frame),
            enabled: String(snapshot.isEnabled),
            focused: String(snapshot.hasFocus),
            selected: String(snapshot.isSelected),
            node: snapshot.children.map { element($0) }
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
