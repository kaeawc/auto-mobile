import Foundation
import XCTest

@MainActor
final class VisionCommandRouter {
    private let application: XCUIApplication

    init(application: XCUIApplication) {
        self.application = application
    }

    private struct Envelope: Decodable {
        let type: String
        let requestId: String?
    }

    private struct TapRequest: Decodable {
        let identifier: String
        let frameContext: String?
    }

    func handle(_ data: Data) -> Data {
        var requestId: String?
        do {
            let decoder = JSONDecoder()
            let envelope = try decoder.decode(Envelope.self, from: data)
            requestId = envelope.requestId
            guard VisionCommandPolicy.supports(envelope.type) else {
                throw CommandError.unknownCommand(envelope.type)
            }
            switch envelope.type {
            case "request_hierarchy":
                let snapshot = try application.snapshot()
                // The spike used descendants(.any), including ornaments whose frames are scene-local.
                let descendants = try application.descendants(matching: .any)
                    .allElementsBoundByIndex.map { try $0.snapshot() }
                let nodes = descendants.map { element($0) }
                let root = UIElementInfo(
                    text: snapshot.label,
                    resourceId: snapshot.identifier,
                    className: String(snapshot.elementType.rawValue),
                    bounds: ElementBounds(clamping: snapshot.frame),
                    enabled: String(snapshot.isEnabled),
                    focused: String(snapshot.hasFocus),
                    node: nodes
                )
                return try JSONEncoder().encode(HierarchyUpdateResponse(
                    requestId: requestId,
                    data: ViewHierarchy(
                        packageName: snapshot.identifier,
                        hierarchy: root,
                        screenWidth: ElementBounds.clampedInt(descendants.reduce(snapshot.frame.width) { max(
                            $0,
                            $1.frame.maxX
                        ) }),
                        screenHeight: ElementBounds.clampedInt(descendants.reduce(snapshot.frame.height) { max(
                            $0,
                            $1.frame.maxY
                        ) })
                    )
                ))
            case "request_tap_element":
                let request = try decoder.decode(TapRequest.self, from: data)
                guard !request.identifier.isEmpty, request.frameContext == nil else {
                    throw CommandError.invalidParameter(
                        "identifier",
                        "supply a unique accessibility identifier; frame taps are unsupported"
                    )
                }
                let matches = application.descendants(matching: .any).matching(identifier: request.identifier)
                guard matches.count == 1, matches.firstMatch.isEnabled else {
                    throw CommandError.invalidParameter(
                        "identifier",
                        "element missing, ambiguous or disabled; observe again"
                    )
                }
                // Never translate an ornament frame to a coordinate.
                matches.firstMatch.tap()
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "tap_element_result", requestId: requestId, totalTimeMs: 0
                ))
            case "request_append_text":
                let request = try decoder.decode(RequestAppendText.self, from: data)
                guard !request.text.isEmpty, request.frameContext == nil else {
                    throw CommandError.invalidParameter("text", "supply non-empty append text without frameContext")
                }
                var focusedFields: [XCUIElement] = []
                let textTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .textView, .searchField]
                for candidate in application.descendants(matching: .any).allElementsBoundByIndex {
                    let snapshot = try candidate.snapshot()
                    if snapshot.hasFocus, textTypes.contains(snapshot.elementType) {
                        focusedFields.append(candidate)
                    }
                }
                guard focusedFields.count == 1 else {
                    throw CommandError.invalidParameter(
                        "text",
                        "no unique focused text input; focus it with tapOn first"
                    )
                }
                focusedFields[0].typeText(request.text)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "append_text_result", requestId: requestId, totalTimeMs: 0
                ))
            default:
                throw CommandError.unknownCommand(envelope.type)
            }
        } catch {
            let response = WebSocketResponse.error(
                type: "error", requestId: requestId, error: error.localizedDescription,
                errorCode: (error as? CommandError)?.wireCode
            )
            return (try? JSONEncoder().encode(response))
                ?? Data(#"{"type":"error","success":false,"error":"Response encoding failed"}"#.utf8)
        }
    }

    private func element(_ snapshot: any XCUIElementSnapshot) -> UIElementInfo {
        UIElementInfo(
            text: snapshot.label,
            resourceId: snapshot.identifier,
            className: String(snapshot.elementType.rawValue),
            bounds: ElementBounds(clamping: snapshot.frame),
            enabled: String(snapshot.isEnabled),
            focused: String(snapshot.hasFocus)
        )
    }
}
