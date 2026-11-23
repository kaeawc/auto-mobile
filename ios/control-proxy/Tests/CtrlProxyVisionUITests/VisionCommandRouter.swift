import Foundation
import XCTest

@MainActor
final class VisionCommandRouter {
    private let application: XCUIApplication
    /// Selector of the element the last `request_tap_element` hit (identifier, or label and type);
    /// typing falls back to it when no field reports focus.
    private var lastTappedSelector: VisionCommandPolicy.TapSelector?

    init(application: XCUIApplication) {
        self.application = application
    }

    private struct Envelope: Decodable {
        let type: String
        let requestId: String?
    }

    private struct TapRequest: Decodable {
        let identifier: String
        let label: String?
        let elementType: UInt?
        let frameContext: String?
    }

    /// Points in the hierarchy's space, as observe reports element bounds.
    private struct TapCoordinatesRequest: Decodable {
        let x: Double
        let y: Double
        let frameContext: String?
    }

    private struct SwipeRequest: Decodable {
        let x1: Double
        let y1: Double
        let x2: Double
        let y2: Double
        let duration: Int
        let frameContext: String?
    }

    /// The offset from the target application's frame origin to a hierarchy point, `nil` for an
    /// invalid point. The origin is read at dispatch so a moved window keeps hierarchy points aligned.
    private func offset(x: Double, y: Double) -> VisionCommandPolicy.Offset? {
        let origin = application.frame.origin
        return VisionCommandPolicy.coordinateOffset(
            x: x, y: y, appOriginX: Double(origin.x), appOriginY: Double(origin.y)
        )
    }

    private func coordinate(_ offset: VisionCommandPolicy.Offset) -> XCUICoordinate {
        application.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: offset.dx, dy: offset.dy))
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
                guard let selector = VisionCommandPolicy.tapSelector(
                    identifier: request.identifier, label: request.label,
                    elementType: request.elementType, frameContext: request.frameContext
                ) else {
                    throw CommandError.invalidParameter(
                        "identifier",
                        "supply an accessibility identifier or a non-empty label and elementType; frame taps are unsupported"
                    )
                }
                let descendants = application.descendants(matching: .any)
                let queried: [XCUIElement]
                switch selector {
                case let .identifier(identifier):
                    // Identifier queries also match labels; the snapshot filter checks the own identifier.
                    queried = descendants.matching(identifier: identifier).allElementsBoundByIndex
                case let .label(label, _):
                    queried = descendants.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
                }
                let resolved = try queried.map { try (element: $0, snapshot: $0.snapshot()) }
                    .filter {
                        selector.matches(
                            identifier: $0.snapshot.identifier, label: $0.snapshot.label,
                            elementType: $0.snapshot.elementType.rawValue
                        )
                    }
                let matches = resolved.map(\.element)
                let snapshots = resolved.map(\.snapshot)
                let candidates = snapshots.map {
                    VisionCommandPolicy.TapCandidate(
                        elementType: $0.elementType.rawValue, label: $0.label, isEnabled: $0.isEnabled
                    )
                }
                switch VisionCommandPolicy.tapResolution(
                    candidates: candidates, label: request.label, elementType: request.elementType
                ) {
                case let .match(index):
                    // Never translate an ornament frame to a coordinate.
                    matches[index].tap()
                case .missing:
                    throw CommandError.invalidParameter(
                        "identifier",
                        "no element matches the selector (and type/label when supplied); observe again"
                    )
                case .disabled:
                    throw CommandError.invalidParameter(
                        "identifier",
                        "element disabled; observe again and select an enabled control"
                    )
                case let .ambiguous(count):
                    let details = snapshots.map {
                        "\($0.elementType.rawValue)/\($0.label)/\($0.frame)"
                    }.joined(separator: "; ")
                    throw CommandError.executionFailed(
                        "ambiguous_element: \(count) enabled elements share selector '\(selector)' "
                            + "with the supplied type/label; candidates: \(details)"
                    )
                }
                lastTappedSelector = selector
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
                var textInputs: [XCUIElement] = []
                var textInputCandidates: [VisionCommandPolicy.TextInputCandidate] = []
                let textTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .textView, .searchField]
                for candidate in application.descendants(matching: .any).allElementsBoundByIndex {
                    let snapshot = try candidate.snapshot()
                    guard textTypes.contains(snapshot.elementType) else { continue }
                    if snapshot.hasFocus {
                        focusedFields.append(candidate)
                    }
                    textInputs.append(candidate)
                    textInputCandidates.append(VisionCommandPolicy.TextInputCandidate(
                        identifier: snapshot.identifier, label: snapshot.label,
                        elementType: snapshot.elementType.rawValue
                    ))
                }
                let lastTappedFields = VisionCommandPolicy.lastTappedTextInputIndices(
                    candidates: textInputCandidates, lastTapped: lastTappedSelector
                ).map { textInputs[$0] }
                let target: XCUIElement
                switch VisionCommandPolicy.typingTarget(
                    focusedCount: focusedFields.count,
                    lastTappedTextInputCount: lastTappedFields.count
                ) {
                case .focused: target = focusedFields[0]
                case .lastTapped:
                    target = lastTappedFields[0]
                    // visionOS typeText needs a focusing tap to preserve existing text (#17312).
                    target.tap()
                    for _ in 0 ..< 10 {
                        if (try? target.snapshot().hasFocus) == true { break }
                        let focusPending = XCTestExpectation(description: "Waiting for text input focus")
                        _ = XCTWaiter().wait(for: [focusPending], timeout: 0.1)
                    }
                case .none: throw CommandError.noFocusedTextInput
                }
                target.typeText(request.text)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "append_text_result", requestId: requestId, totalTimeMs: 0
                ))
            case "request_tap_coordinates":
                let request = try decoder.decode(TapCoordinatesRequest.self, from: data)
                guard request.frameContext == nil, let point = offset(x: request.x, y: request.y) else {
                    throw CommandError.invalidParameter(
                        "x", "supply finite non-negative x/y in window points without frameContext"
                    )
                }
                coordinate(point).tap()
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "tap_coordinates_result", requestId: requestId, totalTimeMs: 0
                ))
            case "request_swipe":
                let request = try decoder.decode(SwipeRequest.self, from: data)
                guard request.frameContext == nil,
                      let start = offset(x: request.x1, y: request.y1),
                      let end = offset(x: request.x2, y: request.y2),
                      let velocity = VisionCommandPolicy.swipeVelocity(
                          from: start, to: end, durationMs: request.duration
                      )
                else {
                    throw CommandError.invalidParameter(
                        "x1",
                        "supply finite non-negative window points at least one point apart and a duration of "
                            + "\(VisionCommandPolicy.swipeDurationRangeMs.lowerBound)-"
                            + "\(VisionCommandPolicy.swipeDurationRangeMs.upperBound) ms without frameContext"
                    )
                }
                coordinate(start).press(
                    forDuration: 0.05,
                    thenDragTo: coordinate(end),
                    withVelocity: XCUIGestureVelocity(CGFloat(velocity)),
                    thenHoldForDuration: 0
                )
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "swipe_result", requestId: requestId, totalTimeMs: 0
                ))
            case "request_press_home":
                // The Digital Crown press: visionOS shows the Home View over the shared space.
                XCUIDevice.shared.press(.home)
                return try JSONEncoder().encode(WebSocketResponse.success(
                    type: "press_home_result", requestId: requestId, totalTimeMs: 0
                ))
            default:
                throw CommandError.unknownCommand(envelope.type)
            }
        } catch {
            // Preserve the machine-readable ambiguity prefix without changing shared iOS errors.
            var wireError = error.localizedDescription
            if let commandError = error as? CommandError,
               case let .executionFailed(reason) = commandError,
               reason.hasPrefix("ambiguous_element:")
            {
                wireError = reason
            }
            let response = WebSocketResponse.error(
                type: "error", requestId: requestId, error: wireError,
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
            value: traits.snapshotValue(
                snapshot.value,
                placeholder: snapshot.placeholderValue,
                isToggle: [.switch, .toggle, .checkBox].contains(snapshot.elementType)
            ),
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
