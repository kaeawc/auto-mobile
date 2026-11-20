#if canImport(XCTest) && os(iOS)
    import os
    import XCTest
#endif

@MainActor
protocol UIInterruptionConfiguring {
    var supportsSkippingUIInterruptions: Bool { get }
    func setSkipsUIInterruptions(_ skips: Bool)
}

@MainActor
enum UIInterruptionConfiguration {
    static func apply(to app: some UIInterruptionConfiguring) throws -> Bool {
        try catchingObjCException {
            guard app.supportsSkippingUIInterruptions else { return false }
            app.setSkipsUIInterruptions(true)
            return true
        }
    }
}

#if canImport(XCTest) && os(iOS)
    @MainActor
    extension XCUIApplication: UIInterruptionConfiguring {
        private static let warnUnsupportedUIInterruptionSetting: Void = {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "CtrlProxy")
                .warning("Could not disable XCUITest's default UI interruption handling")
        }()

        var supportsSkippingUIInterruptions: Bool {
            responds(to: NSSelectorFromString("setDoesNotHandleUIInterruptions:"))
        }

        func setSkipsUIInterruptions(_ skips: Bool) {
            setValue(skips, forKey: "doesNotHandleUIInterruptions")
        }

        static func withoutUIInterruptions(bundleIdentifier: String) -> XCUIApplication {
            let app = XCUIApplication(bundleIdentifier: bundleIdentifier)
            app.skipUIInterruptions()
            return app
        }

        func skipUIInterruptions() {
            // A gesture or snapshot must leave permission alerts for explicit handling.
            if (try? UIInterruptionConfiguration.apply(to: self)) != true {
                _ = Self.warnUnsupportedUIInterruptionSetting
            }
        }
    }
#endif
