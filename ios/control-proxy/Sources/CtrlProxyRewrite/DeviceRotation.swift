import Foundation
#if canImport(UIKit) && os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Maps platform orientation observations to the rotation epoch shared by hierarchy
/// and screenshot frames. A value is intentionally absent when the platform cannot
/// identify an interface rotation.
///
/// PHASE 4F: adds the process-lifetime capture epoch (`startMonitoring` / `capture` /
/// `captureSample`) that `ElementLocator.getViewHierarchy` requires to close the
/// non-atomic multi-hop capture race. The gesture-orientation members
/// (`current`, `currentGestureInterfaceOrientation`, `gestureInterfaceOrientation`) land
/// with the `@MainActor` `GesturePerformer` in Phase 4G.
enum DeviceRotation {
    static func fromOrientationName(_ orientation: String) -> Int? {
        switch orientation {
        case "portrait": return 0
        case "landscape_left": return 1
        case "portrait_upside_down": return 2
        case "landscape_right": return 3
        default: return nil
        }
    }

    #if canImport(XCTest) && os(iOS)
        /// `@unchecked Sendable`: `observer` is written once (in `startObserving`, which
        /// the monitor's `init` calls exactly once) and read only in `deinit`; the
        /// delivery queue is an immutable serial `OperationQueue`. The type is stored as
        /// the immutable `signal` of the `Sendable` `changeMonitor` global.
        private final class DeviceOrientationChangeSignal: RotationChangeSignaling, @unchecked Sendable {
            private let deliveryQueue: OperationQueue = {
                let queue = OperationQueue()
                queue.name = "dev.jasonpearson.automobile.ctrlproxy.device-orientation"
                queue.maxConcurrentOperationCount = 1
                return queue
            }()
            private var observer: NSObjectProtocol?

            init() {
                UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            }

            func startObserving(_ handler: @escaping @Sendable () -> Void) {
                observer = NotificationCenter.default.addObserver(
                    forName: UIDevice.orientationDidChangeNotification,
                    object: UIDevice.current,
                    queue: deliveryQueue
                ) { _ in
                    handler()
                }
            }

            deinit {
                if let observer {
                    NotificationCenter.default.removeObserver(observer)
                }
                UIDevice.current.endGeneratingDeviceOrientationNotifications()
            }
        }

        /// Stateless → genuinely `Sendable`; stored as the `rotationSampler` global.
        private final class XCUIDeviceRotationSampler: RotationSampling, Sendable {
            func currentRotation() -> Int? {
                switch XCUIDevice.shared.orientation {
                case .portrait: return 0
                case .landscapeLeft: return 1
                case .portraitUpsideDown: return 2
                case .landscapeRight: return 3
                default: return nil
                }
            }
        }

        private static let rotationSampler = XCUIDeviceRotationSampler()
        private static let changeMonitor = RotationChangeMonitor(signal: DeviceOrientationChangeSignal())

        /// Must be called while constructing the capture owners, before any synchronous XCUI work
        /// can block the runner's main thread.
        static func startMonitoring() {
            _ = changeMonitor
        }

        static func capture<T>(_ operation: () throws -> T) rethrows -> (value: T, rotation: Int?) {
            try changeMonitor.capture(using: rotationSampler, operation)
        }

        static func captureSample() -> RotationCaptureSample {
            changeMonitor.captureSample(using: rotationSampler)
        }
    #endif
}
