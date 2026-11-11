@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The static month grid a recording-mode `datePicker` draws (#17871).
final class PrototypeCalendarMonthTests: XCTestCase {
    private let calendar = PrototypeRecordingMode.calendar

    private func day(_ text: String) throws -> Date {
        try XCTUnwrap(PrototypeDate.date(from: text))
    }

    func testDialogFixtureMonthIsOctober2026WithTheBoundDaySelected() throws {
        let selected = try day("2026-10-08")
        let month = PrototypeCalendarMonth.make(showing: selected, selected: selected, calendar: calendar)

        XCTAssertEqual(month.year, 2026)
        XCTAssertEqual(month.month, 10)
        XCTAssertEqual(month.title, "October 2026")
        XCTAssertEqual(month.weekdaySymbols, ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])
        XCTAssertEqual(month.selectedDay, 8)
        // 2026-10-01 is a Thursday.
        XCTAssertEqual(month.weeks[0], [nil, nil, nil, nil, 1, 2, 3])
        XCTAssertEqual(month.weeks[4], [25, 26, 27, 28, 29, 30, 31])
        XCTAssertEqual(month.weeks[5], Array(repeating: nil, count: 7))
    }

    func testGridIsAlwaysSixWeeksOfSevenDays() throws {
        // February 2026 starts on Sunday and fills exactly four weeks.
        let february = PrototypeCalendarMonth.make(showing: try day("2026-02-10"), selected: nil, calendar: calendar)
        XCTAssertEqual(february.weeks.count, PrototypeCalendarMonth.weekCount)
        XCTAssertTrue(february.weeks.allSatisfy { $0.count == 7 })
        XCTAssertEqual(february.weeks[0], [1, 2, 3, 4, 5, 6, 7])
        XCTAssertEqual(february.weeks.flatMap { $0 }.compactMap { $0 }, Array(1 ... 28))
        XCTAssertNil(february.selectedDay)

        // August 2026 starts on Saturday and spills into a sixth week.
        let august = PrototypeCalendarMonth.make(showing: try day("2026-08-01"), selected: nil, calendar: calendar)
        XCTAssertEqual(august.weeks[0], [nil, nil, nil, nil, nil, nil, 1])
        XCTAssertEqual(august.weeks[5], [30, 31, nil, nil, nil, nil, nil])
    }

    func testSelectionOutsideTheShownMonthIsNotMarked() throws {
        let shown = PrototypeCalendarMonth.month(of: try day("2026-10-08"), offset: 1, calendar: calendar)
        let month = PrototypeCalendarMonth.make(showing: shown, selected: try day("2026-10-08"), calendar: calendar)
        XCTAssertEqual(month.title, "November 2026")
        XCTAssertNil(month.selectedDay)
        // Same day number a year apart is a different month.
        let lastYear = PrototypeCalendarMonth.make(
            showing: try day("2025-10-08"), selected: try day("2026-10-08"), calendar: calendar
        )
        XCTAssertNil(lastYear.selectedDay)
    }

    func testMonthOffsetsCrossYearsAndTappedDaysAreUTCMidnights() throws {
        let previous = PrototypeCalendarMonth.month(of: try day("2026-01-15"), offset: -1, calendar: calendar)
        XCTAssertEqual(PrototypeDate.string(from: previous), "2025-12-01")
        let month = PrototypeCalendarMonth.make(showing: previous, selected: nil, calendar: calendar)
        let tapped = try XCTUnwrap(month.date(day: 31, calendar: calendar))
        XCTAssertEqual(tapped, try day("2025-12-31"))
    }

    func testSameInputsAlwaysBuildTheSameMonth() throws {
        let selected = try day("2026-10-08")
        XCTAssertEqual(
            PrototypeCalendarMonth.make(showing: selected, selected: selected, calendar: calendar),
            PrototypeCalendarMonth.make(showing: selected, selected: selected, calendar: calendar)
        )
    }

    func testRecordingOpensAnUnboundPickerOnThePinnedDay() throws {
        XCTAssertEqual(PrototypeRecordingMode.on.datePickerSelection(bound: nil), try day("2026-01-15"))
        XCTAssertEqual(PrototypeRecordingMode.on.datePickerSelection(bound: "2026-02-30"), try day("2026-01-15"))
        let month = PrototypeCalendarMonth.make(
            showing: PrototypeRecordingMode.on.datePickerSelection(bound: nil),
            selected: PrototypeRecordingMode.on.datePickerSelection(bound: nil),
            calendar: calendar
        )
        XCTAssertEqual(month.title, "January 2026")
        XCTAssertEqual(month.selectedDay, 15)
    }

    func testBoundDayWinsAndNormalViewingKeepsItsFallback() throws {
        XCTAssertEqual(PrototypeRecordingMode.on.datePickerSelection(bound: "2026-10-08"), try day("2026-10-08"))
        XCTAssertEqual(PrototypeRecordingMode.off.datePickerSelection(bound: "2026-10-08"), try day("2026-10-08"))
        XCTAssertEqual(PrototypeRecordingMode.off.datePickerSelection(bound: nil), PrototypeDate.range.lowerBound)
        XCTAssertEqual(PrototypeRecordingMode.off.datePickerSelection(bound: "nope"), PrototypeDate.range.lowerBound)
    }
}
