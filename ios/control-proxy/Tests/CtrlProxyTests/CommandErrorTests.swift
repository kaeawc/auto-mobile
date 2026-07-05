@testable import CtrlProxy
import XCTest

/// Pins the message contract of every *live* `CommandError` case after the dead
/// `.notSupported` / `.elementNotFound` cases were removed (issue #2859 part 1):
/// they had no constructors anywhere in `CtrlProxy` (all `.notSupported(` /
/// `.elementNotFound(` throws are on the separate `GestureError` / `LocatorError`
/// enums). Deleting a still-used case, or reintroducing a dead one, would break
/// this suite or the build.
final class CommandErrorTests: XCTestCase {
    /// The unknownCommand wire text is load-bearing: the TS client's
    /// `rewriteUnknownCommandError` regex-matches it to flag a stale runner, so it
    /// is pinned byte-for-byte.
    func testUnknownCommandMessageIsWireStable() {
        XCTAssertEqual(
            CommandError.unknownCommand("frobnicate").errorDescription,
            "Unknown command type: frobnicate"
        )
    }

    func testMissingParameterMessage() {
        XCTAssertEqual(
            CommandError.missingParameter("bundleId").errorDescription,
            "Missing required parameter: bundleId"
        )
    }

    func testInvalidParameterMessage() {
        XCTAssertEqual(
            CommandError.invalidParameter("orientation", "sideways").errorDescription,
            "Invalid value 'sideways' for parameter 'orientation'"
        )
    }

    func testExecutionFailedMessage() {
        XCTAssertEqual(
            CommandError.executionFailed("disk full").errorDescription,
            "Command execution failed: disk full"
        )
    }

    /// Every live case produces a non-empty, non-generic description — a total
    /// check that no arm silently falls through to `nil`.
    func testEveryLiveCaseHasADescription() {
        let cases: [CommandError] = [
            .unknownCommand("c"),
            .missingParameter("p"),
            .invalidParameter("p", "v"),
            .executionFailed("r"),
        ]
        for error in cases {
            XCTAssertFalse((error.errorDescription ?? "").isEmpty, "\(error) should have a description")
        }
    }
}
