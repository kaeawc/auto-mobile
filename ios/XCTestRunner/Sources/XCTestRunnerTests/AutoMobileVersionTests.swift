import XCTest
@testable import XCTestRunner

final class AutoMobileVersionTests: XCTestCase {
    func testCurrentVersionIsNonEmptySemver() throws {
        let version = AutoMobileVersion.current
        XCTAssertFalse(version.isEmpty, "baked client version must not be empty")

        // MAJOR.MINOR.PATCH release portion the daemon handshake compares against.
        let components = version.split(separator: "+").first.map(String.init) ?? version
        let parts = components.split(separator: ".")
        XCTAssertEqual(parts.count, 3, "version should be MAJOR.MINOR.PATCH, got \(version)")
        for part in parts {
            XCTAssertNotNil(Int(part), "version component \(part) should be numeric in \(version)")
        }
    }
}
