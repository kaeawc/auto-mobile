import XCTest

final class FilesFixtureProviderUITests: XCTestCase {
    func testSelectsTheExactPutAppFileFixture() {
        let app = XCUIApplication()
        app.launchEnvironment["AUTOMOBILE_FIXTURE_NAMESPACE"] = "issue-5807-smoke"
        app.launch()

        let openPicker = app.buttons["open-document-picker"]
        XCTAssertTrue(openPicker.waitForExistence(timeout: 5))
        openPicker.tap()

        // Files presents the extension separately from the item title in icon mode.
        // Tapping the visible title targets the selectable document item on both layouts.
        let fixture = app.staticTexts["issue-5807-fixture"]
        XCTAssertTrue(fixture.waitForExistence(timeout: 10), app.debugDescription)
        fixture.tap()

        let selected = app.staticTexts["selected-document"]
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        XCTAssertEqual(selected.label, "issue-5807-fixture.txt")
        XCTAssertTrue(openPicker.waitForExistence(timeout: 5))
        XCTAssertTrue(openPicker.isHittable, app.debugDescription)
    }
}
