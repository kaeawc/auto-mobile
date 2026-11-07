import Foundation
import XCTest

@MainActor
final class VisionCommandRouter {
    private let application: XCUIApplication
    /// Identifier of the element the last `request_tap_element` hit; typing falls back to it when
    /// no field reports focus.
    private var lastTappedIdentifier: String?

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
                let snapshot: any XCUIElementSnapshot
                do {
                    snapshot = try application.snapshot()
                } catch {
                    guard VisionCommandPolicy.shouldRelaunchForSnapshotError(String(describing: error)) else {
                        throw error
                    }
                    // Recover this app's inaccessible main window once (#17448).
                    application.terminate()
                    application.launch()
                    snapshot = try application.snapshot()
                }
                // One snapshot already carries the whole tree, ornaments included. Snapshotting each
                // descendant query result costs a round trip per element (about 100 ms each, 26 s for
                // Settings' 259 elements), which exceeded the 20 s hierarchy budget (#17218).
                let descendants = Self.flattenedDescendants(of: snapshot)
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
                lastTappedIdentifier = request.identifier
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "tap_element_result", requestId: requestId, totalTimeMs: 0
                ))
            case "request_append_text":
                let request = try decoder.decode(RequestAppendText.self, from: data)
                guard !request.text.isEmpty, request.frameContext == nil else {
                    throw CommandError.invalidParameter("text", "supply non-empty append text without frameContext")
                }
                guard !VisionCommandPolicy.containsDeleteKey(request.text),
                      !request.text.contains(XCUIKeyboardKey.delete.rawValue)
                else {
                    throw CommandError.invalidParameter("text", "append text must not contain the delete key")
                }
                var focusedFields: [XCUIElement] = []
                var lastTappedFields: [XCUIElement] = []
                let textTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .textView, .searchField]
                for candidate in application.descendants(matching: .any).allElementsBoundByIndex {
                    let snapshot = try candidate.snapshot()
                    guard textTypes.contains(snapshot.elementType) else { continue }
                    if snapshot.hasFocus {
                        focusedFields.append(candidate)
                    }
                    if let tapped = lastTappedIdentifier, snapshot.identifier == tapped {
                        lastTappedFields.append(candidate)
                    }
                }
                let target: XCUIElement
                switch VisionCommandPolicy.typingTarget(
                    focusedCount: focusedFields.count,
                    lastTappedTextInputCount: lastTappedFields.count
                ) {
                case .focused: target = focusedFields[0]
                case .lastTapped: target = lastTappedFields[0]
                case .none: throw CommandError.noFocusedTextInput
                }
                target.typeText(request.text)
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

    private static func flattenedDescendants(of snapshot: any XCUIElementSnapshot) -> [any XCUIElementSnapshot] {
        snapshot.children.flatMap { [$0] + flattenedDescendants(of: $0) }
    }

    private func kind(of type: XCUIElement.ElementType) -> VisionElementKind {
        switch type {
        case .button, .link, .switch, .toggle, .checkBox, .radioButton, .segmentedControl, .cell, .tab:
            return .button
        case .textField, .textView, .searchField:
            return .textInput
        case .secureTextField:
            return .secureTextInput
        default:
            return .other
        }
    }

    private func element(_ snapshot: any XCUIElementSnapshot) -> UIElementInfo {
        let traits = VisionElementTraits.traits(for: kind(of: snapshot.elementType), isEnabled: snapshot.isEnabled)
        return UIElementInfo(
            text: snapshot.label,
            value: traits.enteredValue(snapshot.value, placeholder: snapshot.placeholderValue),
            resourceId: snapshot.identifier,
            className: String(snapshot.elementType.rawValue),
            bounds: ElementBounds(clamping: snapshot.frame),
            clickable: traits.clickable,
            enabled: String(snapshot.isEnabled),
            focusable: traits.focusable,
            focused: String(snapshot.hasFocus),
            actions: traits.actions
        )
    }
}
