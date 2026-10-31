import AutoMobileSdkWire
import Foundation
import XCTest

@MainActor
final class WatchXCUISource: WatchSnapshotSource, WatchGesturePerformer {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    func snapshot() throws -> SdkViewHierarchy {
        let root = try app.snapshot()
        // XCUITest frames and gesture coordinates are points. No pixel scale is inferred.
        return SdkViewHierarchy(
            screenScale: 1, screenWidth: Int(root.frame.width), screenHeight: Int(root.frame.height),
            root: node(root)
        )
    }

    private func node(_ snapshot: any XCUIElementSnapshot) -> SdkViewNode {
        let frame = snapshot.frame
        return SdkViewNode(
            // Preserve the XCUITest raw element type without claiming an in-app SwiftUI class.
            className: "XCUIElementType(\(snapshot.elementType.rawValue))",
            bounds: SdkBounds(
                left: Int(frame.minX), top: Int(frame.minY), right: Int(frame.maxX), bottom: Int(frame.maxY)
            ),
            accessibilityLabel: snapshot.label,
            accessibilityIdentifier: snapshot.identifier,
            isUserInteractionEnabled: snapshot.isEnabled,
            children: snapshot.children.map { node($0) }
        )
    }

    func tap(x: Double, y: Double) throws {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
    }

    func tap(identifier: String) throws {
        let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        guard element.exists else {
            throw WatchCommandError.commandFailed("No watchOS element with identifier '\(identifier)'")
        }
        element.tap()
    }

    func swipe(_ direction: WatchSwipeDirection) throws {
        switch direction {
        case .up: app.swipeUp()
        case .down: app.swipeDown()
        case .left: app.swipeLeft()
        case .right: app.swipeRight()
        }
    }
}
