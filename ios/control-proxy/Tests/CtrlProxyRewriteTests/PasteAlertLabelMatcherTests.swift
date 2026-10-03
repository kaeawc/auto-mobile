@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class PasteAlertLabelMatcherTests: XCTestCase {
    private struct FixtureRow {
        let locale: String
        let allow: String
        let deny: String
    }

    private func fixtureRows() throws -> [FixtureRow] {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("PasteAlertStrings/uikitcore-paste-strings.tsv")
        let contents: String
        do {
            contents = try String(contentsOf: fixtureURL, encoding: .utf8)
        } catch {
            XCTFail("Missing or unreadable paste-alert fixture at \(fixtureURL.path): \(error)")
            throw error
        }
        let rows = contents.split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("#") && !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .compactMap { line -> FixtureRow? in
                let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
                guard fields.count == 4 else {
                    XCTFail("Expected four TSV columns in paste-alert fixture row: \(line)")
                    return nil
                }
                return FixtureRow(locale: String(fields[0]), allow: String(fields[1]), deny: String(fields[2]))
            }
        XCTAssertFalse(rows.isEmpty, "Paste-alert fixture must contain labels")
        return rows
    }

    func testEveryFixtureAllowLabelMatchesAndTableCannotDrift() throws {
        let rows = try fixtureRows()
        for row in rows {
            XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel(row.allow), "Allow label for \(row.locale)")
        }
        XCTAssertEqual(Set(rows.map(\.allow)), PasteAlertLabelMatcher.allowPasteLabels)
    }

    func testFixtureDenyLabelsNeverMatchOrOverlapAllowLabels() throws {
        let rows = try fixtureRows()
        let denyLabels = Set(rows.map(\.deny))
        XCTAssertTrue(Set(rows.map(\.allow)).isDisjoint(with: denyLabels))
        for row in rows {
            XCTAssertFalse(PasteAlertLabelMatcher.isAllowPasteLabel(row.deny), "Deny label for \(row.locale)")
            for deny in [
                row.deny.replacingOccurrences(of: "’", with: "'"),
                row.deny.replacingOccurrences(of: "'", with: "’"),
            ] {
                XCTAssertFalse(PasteAlertLabelMatcher.isAllowPasteLabel(deny), "Normalized deny for \(row.locale)")
            }
        }
    }

    func testEnglishAndWhitespaceTrimming() throws {
        XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel("Allow Paste"))
        for row in try fixtureRows() {
            XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel(" \n\t\(row.allow)\r\n "))
        }
    }

    func testApostropheVariantsMatchAllowLabels() throws {
        for row in try fixtureRows() {
            let straight = row.allow.replacingOccurrences(of: "’", with: "'")
            XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel(straight), "Straight apostrophe for \(row.locale)")
            XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel(straight.replacingOccurrences(of: "'", with: "’")))
            XCTAssertTrue(PasteAlertLabelMatcher.isAllowPasteLabel(straight.replacingOccurrences(of: "'", with: "‘")))
        }
    }

    func testUnknownEmptyAndEnglishDenyLabelsNeverMatch() {
        for label in [
            "",
            " \n\t ",
            "Don't Allow",
            "Don’t Allow",
            "Don‘t Allow",
            "Don't Allow Paste",
            "Don’t Allow Paste",
            "Don‘t Allow Paste",
            "Allow",
            "Allow Pasting",
            "allow paste",
            "Allow Paste!",
            "Don't Allow Paste Please",
        ] {
            XCTAssertFalse(PasteAlertLabelMatcher.isAllowPasteLabel(label), "Unexpected match for \(label)")
        }
    }
}
