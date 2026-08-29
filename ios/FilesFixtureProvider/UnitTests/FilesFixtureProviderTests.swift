import XCTest

final class FilesFixtureProviderTests: XCTestCase {
    func testAppPublishesItsDocumentsDirectoryThroughTheLocalFilesProvider() {
        XCTAssertEqual(
            Bundle.main.bundleIdentifier,
            "dev.jasonpearson.automobile.files-fixture-provider"
        )
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "UIFileSharingEnabled") as? Bool, true)
        XCTAssertEqual(
            Bundle.main.object(forInfoDictionaryKey: "LSSupportsOpeningDocumentsInPlace") as? Bool,
            true
        )
    }
}
