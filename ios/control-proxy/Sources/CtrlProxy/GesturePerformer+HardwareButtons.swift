import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if canImport(XCTest) && os(iOS)
    extension GesturePerformer {
        public func pressHome() throws {
            try catchingObjCException {
                XCUIDevice.shared.press(.home)
            }
        }

        public func shake() throws {
            try catchingObjCException {
                let notificationName = CFNotificationName("com.apple.UIKit.SimulatorShake" as CFString)
                CFNotificationCenterPostNotification(
                    CFNotificationCenterGetDarwinNotifyCenter(),
                    notificationName,
                    nil,
                    nil,
                    true
                )
            }
        }

        public func pressBack() throws {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                if self.tapExplicitNavigationBarBackButton(in: app) {
                    return
                }
                try self.swipeFromLeftEdge(in: app)
            }
        }

        private func tapExplicitNavigationBarBackButton(in app: XCUIApplication) -> Bool {
            for navigationBar in app.navigationBars.allElementsBoundByIndex where navigationBar.exists {
                let midpoint = navigationBar.frame.midX
                for button in navigationBar.buttons.allElementsBoundByIndex where button.exists && button.isHittable {
                    if button.frame.midX <= midpoint && self.isExplicitBackButton(button) {
                        button.tap()
                        return true
                    }
                }
            }
            return false
        }

        private func isExplicitBackButton(_ button: XCUIElement) -> Bool {
            let candidates = [button.label, button.identifier]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty }
            return candidates.contains { value in
                value == "back" || value.contains("back button") || value.contains("go back")
            }
        }

        private func swipeFromLeftEdge(in app: XCUIApplication) throws {
            let frame = app.frame
            guard frame.width > 0, frame.height > 0 else {
                throw GestureError.gestureFailed("Cannot determine application frame for back gesture")
            }

            let start = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 2, dy: frame.height / 2))
            let end = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: min(frame.width * 0.75, frame.width - 2), dy: frame.height / 2))
            start.press(
                forDuration: 0.05,
                thenDragTo: end,
                withVelocity: .default,
                thenHoldForDuration: 0
            )
        }

        /// Action button and Camera Control exist only on some models (#14100); press only when
        /// XCUITest reports the hardware, so a missing button is a typed refusal, not a silent no-op.
        private func pressOptionalHardwareButton(
            _ deviceButton: XCUIDevice.Button,
            name: String,
            hardware: String
        )
            throws
        {
            guard XCUIDevice.shared.hasHardwareButton(deviceButton) else {
                throw GestureError.notSupported("\(name) button requires a device with \(hardware)")
            }
            try catchingObjCException {
                XCUIDevice.shared.press(deviceButton)
            }
        }

        public func pressButton(_ button: String) throws {
            switch button.lowercased() {
            case "home":
                try pressHome()
            case "recent":
                guard try openRecentApps() else {
                    throw GestureError.gestureFailed("iOS App Switcher did not appear after recent apps invocation")
                }
            case "back":
                try pressBack()
            case "volume_up", "volume_down":
                #if targetEnvironment(simulator)
                    try pressConsumerKeyViaHID(
                        usage: Self.consumerUsage(for: button.lowercased()),
                        button: button
                    )
                #else
                    try catchingObjCException {
                        let deviceButton: XCUIDevice.Button
                        if button.lowercased() == "volume_up" {
                            deviceButton = .volumeUp
                        } else {
                            deviceButton = .volumeDown
                        }
                        XCUIDevice.shared.press(deviceButton)
                    }
                #endif
            case "power":
                try pressConsumerKeyViaHID(usage: Self.consumerUsage(for: "power"), button: button)
            case "action":
                try pressOptionalHardwareButton(.action, name: "action", hardware: "an Action button")
            case "camera":
                try pressOptionalHardwareButton(.camera, name: "camera", hardware: "Camera Control")
            case "menu":
                throw GestureError.notSupported("iOS has no menu hardware button")
            default:
                throw GestureError.notSupported("Button: \(button)")
            }
        }

        private typealias IOHIDEventRef = CFTypeRef
        private typealias IOHIDEventSystemClientRef = CFTypeRef
        private typealias IOHIDEventCreateKeyboardEventFn = @convention(c) (
            CFAllocator?,
            UInt64,
            UInt32,
            UInt32,
            Bool,
            UInt32
        )
            -> Unmanaged<IOHIDEventRef>?
        private typealias IOHIDEventSystemClientCreateFn = @convention(c) (
            CFAllocator?
        )
            -> Unmanaged<IOHIDEventSystemClientRef>?
        private typealias IOHIDEventSystemClientDispatchEventFn = @convention(c) (
            IOHIDEventSystemClientRef,
            IOHIDEventRef
        )
            -> Void

        private func pressConsumerKeyViaHID(usage: UInt32, button: String) throws {
            guard let handle = openIOKitHandle() else {
                throw GestureError.notSupported("\(button) HID support unavailable")
            }
            defer { dlclose(handle) }

            let createEventSymbol = dlsym(handle, "IOHIDEventCreateKeyboardEvent")
            let createClientSymbol = dlsym(handle, "IOHIDEventSystemClientCreate")
            let dispatchEventSymbol = dlsym(handle, "IOHIDEventSystemClientDispatchEvent")

            guard let createEventSymbol, let createClientSymbol, let dispatchEventSymbol else {
                throw GestureError.notSupported("\(button) HID symbols unavailable")
            }

            let createKeyboardEvent = unsafeBitCast(
                createEventSymbol,
                to: IOHIDEventCreateKeyboardEventFn.self
            )
            let createSystemClient = unsafeBitCast(
                createClientSymbol,
                to: IOHIDEventSystemClientCreateFn.self
            )
            let dispatchEvent = unsafeBitCast(
                dispatchEventSymbol,
                to: IOHIDEventSystemClientDispatchEventFn.self
            )

            guard let retainedClient = createSystemClient(nil) else {
                throw GestureError.notSupported("\(button) HID client unavailable")
            }
            let client = retainedClient.takeRetainedValue()

            let consumerUsagePage: UInt32 = 0x0C
            let eventTimestamp: UInt64 = 0
            let eventOptions: UInt32 = 0

            guard let retainedKeyDown = createKeyboardEvent(
                nil,
                eventTimestamp,
                consumerUsagePage,
                usage,
                true,
                eventOptions
            ) else {
                throw GestureError.notSupported("\(button) HID key-down event unavailable")
            }
            let keyDown = retainedKeyDown.takeRetainedValue()

            guard let retainedKeyUp = createKeyboardEvent(
                nil,
                eventTimestamp,
                consumerUsagePage,
                usage,
                false,
                eventOptions
            ) else {
                throw GestureError.notSupported("\(button) HID key-up event unavailable")
            }
            let keyUp = retainedKeyUp.takeRetainedValue()

            dispatchEvent(client, keyDown)
            dispatchEvent(client, keyUp)
        }

        private func openIOKitHandle() -> UnsafeMutableRawPointer? {
            let paths = [
                "/System/Library/Frameworks/IOKit.framework/IOKit",
                "/System/Library/PrivateFrameworks/IOKit.framework/IOKit",
            ]
            for path in paths {
                if let handle = dlopen(path, RTLD_NOW) {
                    return handle
                }
            }
            return nil
        }
    }
#endif
