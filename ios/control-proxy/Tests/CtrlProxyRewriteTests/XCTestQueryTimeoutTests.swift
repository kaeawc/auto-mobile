@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Stand-ins for XCUIAutomation's `_XCTXPCRequestTimeout` / `_XCTSetXPCRequestTimeout`, so the
/// production `dlsym` control's pointer casts are exercised without XCUIAutomation loaded.
private nonisolated(unsafe) var stubXPCRequestTimeout: Double = 30
private let stubGetter: @convention(c) () -> Double = { stubXPCRequestTimeout }
private let stubSetter: @convention(c) (Double) -> Void = { stubXPCRequestTimeout = $0 }

private final class FakeQueryTimeoutControl: XCTestQueryTimeoutControlling {
    var current: TimeInterval?
    var setterAvailable = true
    private(set) var setCalls: [TimeInterval] = []

    init(current: TimeInterval? = 30) {
        self.current = current
    }

    func currentTimeout() -> TimeInterval? {
        current
    }

    func setTimeout(_ seconds: TimeInterval) -> Bool {
        guard setterAvailable else { return false }
        setCalls.append(seconds)
        current = seconds
        return true
    }
}

final class XCTestQueryTimeoutTests: XCTestCase {
    func testUnsetEmptyOrUnparseableValuesSelectTheDefault() {
        for raw in [nil, "", "  ", "abc", "5s", "inf", "nan"] as [String?] {
            XCTAssertEqual(
                XCTestQueryTimeout.selection(environmentValue: raw),
                .apply(XCTestQueryTimeout.defaultSeconds),
                "raw=\(raw ?? "nil")"
            )
        }
        XCTAssertEqual(XCTestQueryTimeout.defaultSeconds, 2)
    }

    func testNumericValuesAreUsedAndClampedToTheAllowedRange() {
        XCTAssertEqual(XCTestQueryTimeout.selection(environmentValue: "5"), .apply(5))
        XCTAssertEqual(XCTestQueryTimeout.selection(environmentValue: " 3.5\n"), .apply(3.5))
        XCTAssertEqual(XCTestQueryTimeout.selection(environmentValue: "0.2"), .apply(1))
        XCTAssertEqual(XCTestQueryTimeout.selection(environmentValue: "600"), .apply(60))
    }

    func testOffZeroOrNegativeKeepXCTestsDefault() {
        for raw in ["off", "OFF", " Off ", "0", "-1"] {
            XCTAssertEqual(XCTestQueryTimeout.selection(environmentValue: raw), .keepXCTestDefault, "raw=\(raw)")
        }
    }

    func testApplySetsTheSelectedTimeoutAndReportsThePreviousValue() {
        let control = FakeQueryTimeoutControl(current: 30)
        var logs: [String] = []
        let outcome = XCTestQueryTimeout.apply(environmentValue: nil, control: control, log: { logs.append($0) })
        XCTAssertEqual(outcome, .applied(previous: 30, current: 2))
        XCTAssertEqual(control.setCalls, [2])
        XCTAssertEqual(logs.count, 1)
        XCTAssertTrue(logs[0].contains("2.0s"), logs[0])
    }

    func testApplyLeavesXCTestAloneWhenDisabled() {
        let control = FakeQueryTimeoutControl(current: 30)
        let outcome = XCTestQueryTimeout.apply(environmentValue: "off", control: control)
        XCTAssertEqual(outcome, .keptXCTestDefault)
        XCTAssertEqual(control.setCalls, [])
        XCTAssertEqual(control.current, 30)
    }

    func testApplyReportsUnavailableWhenTheSetterIsMissing() {
        let control = FakeQueryTimeoutControl(current: nil)
        control.setterAvailable = false
        var logs: [String] = []
        let outcome = XCTestQueryTimeout.apply(environmentValue: "4", control: control, log: { logs.append($0) })
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(logs.count, 1)
        XCTAssertTrue(logs[0].contains("unavailable"), logs[0])
    }

    func testDlsymControlWithoutSymbolsDegradesToUnavailable() {
        var requested: [String] = []
        let control = DlsymXCTestQueryTimeoutControl(lookup: { name in
            requested.append(name)
            return nil
        })
        XCTAssertNil(control.currentTimeout())
        XCTAssertFalse(control.setTimeout(3))
        XCTAssertEqual(requested, ["_XCTXPCRequestTimeout", "_XCTSetXPCRequestTimeout"])
        XCTAssertEqual(XCTestQueryTimeout.apply(environmentValue: nil, control: control), .unavailable)
    }

    func testDlsymControlCallsTheResolvedAccessors() {
        stubXPCRequestTimeout = 30
        let control = DlsymXCTestQueryTimeoutControl(lookup: { name in
            switch name {
            case DlsymXCTestQueryTimeoutControl.getterSymbol: unsafeBitCast(
                    stubGetter,
                    to: UnsafeMutableRawPointer.self
                )
            case DlsymXCTestQueryTimeoutControl.setterSymbol: unsafeBitCast(
                    stubSetter,
                    to: UnsafeMutableRawPointer.self
                )
            default: nil
            }
        })
        XCTAssertEqual(
            XCTestQueryTimeout.apply(environmentValue: "7", control: control),
            .applied(previous: 30, current: 7)
        )
        XCTAssertEqual(stubXPCRequestTimeout, 7)
        XCTAssertEqual(control.currentTimeout(), 7)
    }
}
