import Foundation
import XCTest
@testable import XCTestRunner

final class BoundedStandardErrorTests: XCTestCase {
    func testCapTrimsIncompleteScalar() throws {
        for asciiBytes in [4094, 4095] {
            let prefix = String(repeating: "a", count: asciiBytes)
            let incoming = Data((prefix + "€trailing").utf8)
            let captured = BoundedStandardError.cappedData(incoming)
            let text = try XCTUnwrap(BoundedStandardError.capturedText(from: captured))
            XCTAssertEqual(text, prefix)
            XCTAssertLessThanOrEqual(captured.count, 4096)
            XCTAssertLessThanOrEqual(text.utf8.count, 4096)
        }
    }

    func testCapPreservesCompleteScalar() throws {
        let expected = String(repeating: "a", count: 4093) + "€"
        let captured = BoundedStandardError.cappedData(Data((expected + "trailing").utf8))
        let text = try XCTUnwrap(BoundedStandardError.capturedText(from: captured))
        XCTAssertEqual(text, expected)
        XCTAssertEqual(captured.count, 4096)
    }

    func testEmptyCaptureReturnsNil() {
        XCTAssertNil(BoundedStandardError.capturedText(from: Data()))
    }
}
