import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if !(canImport(XCTest) && os(iOS))
    extension GesturePerformer {
        public func tap(x _: Double, y _: Double, duration _: TimeInterval = 0) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func swipe(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            duration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func multiFingerSwipe(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            fingerCount _: Int,
            fingerSpacing _: Double,
            duration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func drag(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            pressDuration _: TimeInterval,
            dragDuration _: TimeInterval,
            holdDuration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        @discardableResult
        public func pinch(
            centerX _: Double,
            centerY _: Double,
            distanceStart _: Double,
            distanceEnd _: Double,
            rotationDegrees _: Double,
            duration _: TimeInterval
        )
            throws -> PinchGesturePath
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func typeText(text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func appendText(text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setText(resourceId _: String, text _: String) async throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func clearText(resourceId _: String?) async throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func selectAll() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performImeAction(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        @discardableResult
        public func pressKey(key _: String, modifiers _: [String]) async throws -> Bool? {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func keyboard(action _: String) async throws -> KeyboardActionResult {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performAction(
            _: String,
            resourceId _: String?,
            label _: String?,
            bounds _: ElementBounds?,
            duration _: Int?
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func activateAccessibilityLink(text _: String, occurrence _: Int, ownerResourceId _: String?) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getScreenshot() throws -> Data {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setOrientation(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getOrientation() -> String {
            return "unknown"
        }

        public func getDisplayRotation() -> Int? {
            nil
        }

        public func clipboard(action _: String, text _: String?) throws -> String? {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressHome() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressBack() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func shake() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressButton(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func openRecentApps() throws -> Bool {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func launchApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func terminateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func activateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func updateApplication(bundleId _: String) {
            // no-op on non-iOS
        }

        public func resetAuthorizations(bundleId _: String, resources _: [String]) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }
    }
#endif
