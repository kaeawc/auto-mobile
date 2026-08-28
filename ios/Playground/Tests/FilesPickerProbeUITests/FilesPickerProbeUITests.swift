import XCTest

/// Device-backed proof for the bounded local File Provider seam chosen in #5806.
final class FilesPickerProbeUITests: XCTestCase {
    func testSelectsFixtureFromTheLocalFilesProvider() {
        let app = XCUIApplication()
        app.launchEnvironment["PLAYGROUND_INITIAL_TAB"] = "files"
        app.launch()

        let openPicker = app.buttons["open-document-picker"]
        XCTAssertTrue(openPicker.waitForExistence(timeout: 5))
        openPicker.tap()

        let fixture = app.cells.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "automobile-files-probe,")
        ).firstMatch
        XCTAssertTrue(fixture.waitForExistence(timeout: 10), app.debugDescription)
        fixture.tap()

        let selected = app.staticTexts["selected-document"]
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        XCTAssertEqual(selected.label, "automobile-files-probe.txt")
    }
}
