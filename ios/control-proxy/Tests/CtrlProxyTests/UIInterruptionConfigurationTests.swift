@testable import CtrlProxy
import XCTest

final class UIInterruptionConfigurationTests: XCTestCase {
    @MainActor
    private final class App: UIInterruptionConfiguring {
        let supportsSkippingUIInterruptions: Bool
        private(set) var writes: [Bool] = []

        init(supportsSkippingUIInterruptions: Bool) {
            self.supportsSkippingUIInterruptions = supportsSkippingUIInterruptions
        }

        func setSkipsUIInterruptions(_ skips: Bool) {
            writes.append(skips)
        }
    }

    @MainActor
    func testDisablesHandlingWhenSetterIsAvailable() async throws {
        let app = App(supportsSkippingUIInterruptions: true)
        XCTAssertTrue(try UIInterruptionConfiguration.apply(to: app))
        XCTAssertEqual(app.writes, [true])
    }

    @MainActor
    func testSkipsWriteWhenSetterIsUnavailable() async throws {
        let app = App(supportsSkippingUIInterruptions: false)
        XCTAssertFalse(try UIInterruptionConfiguration.apply(to: app))
        XCTAssertTrue(app.writes.isEmpty)
    }
}
