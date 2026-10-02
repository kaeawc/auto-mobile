@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class StorageConcurrencyTests: XCTestCase {
    func testConcurrentDatabaseInspectorRegistrationsRetainEveryEntry() {
        let inspector = DatabaseInspector.shared
        inspector.reset()
        defer { inspector.reset() }
        inspector.configure(StorageInspectionConfiguration(allowMutations: true))
        inspector.setDriver(DefaultDatabaseDriver())
        inspector.setEnabled(true)
        inspector.authorizeHostMutations(true)
        inspector.authorizeSessionMutations(sessionId: "storage-session")

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            inspector.registerAppGroupSuite("group.storage.\(index)")
            inspector.registerCoreDataStore(CoreDataStoreRegistration(
                identifier: "store-\(index)", entities: ["Entry"]
            ))
        }

        let configuration = inspector.inspectionConfiguration
        XCTAssertEqual(configuration.registeredAppGroupSuites, Set((0 ..< 32).map { "group.storage.\($0)" }))
        XCTAssertEqual(Set(configuration.coreDataStores.map(\.identifier)), Set((0 ..< 32).map { "store-\($0)" }))
        XCTAssertEqual(configuration.coreDataStores.count, 32)
        XCTAssertTrue(inspector.isEnabled)
        XCTAssertTrue(inspector.getDriver() is DefaultDatabaseDriver)
        XCTAssertTrue(inspector.canMutate(sessionId: "storage-session", currentSessionId: "storage-session"))
        XCTAssertFalse(inspector.canMutate(sessionId: "other-session", currentSessionId: "storage-session"))
    }

    func testConcurrentDefaultDatabaseDriverCallsKeepStubResults() {
        let driver = DefaultDatabaseDriver()
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            let tables = driver.getTables(databasePath: "/unused")
            let data = driver.getTableData(databasePath: "/unused", table: "entries", limit: 1, offset: 0)
            let structure = driver.getTableStructure(databasePath: "/unused", table: "entries")
            let sql = driver.executeSQL(databasePath: "/unused", query: "SELECT 1")
            if tables.isEmpty, data.columns.isEmpty, data.rows.isEmpty, data.totalRows == 0,
               structure.columns.isEmpty, sql.rowsAffected == 0,
               sql.error == "Not implemented. Provide a custom DatabaseDriver."
            {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(successes.withLock { $0 }, 32)
    }

    func testConcurrentDefaultUserDefaultsDriverCallsAndDateEncoding() {
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in
            calls.withLock { $0 += 1 }
            return nil
        })
        let dates = [
            Date(timeIntervalSince1970: 0),
            Date(timeIntervalSince1970: -1.125),
            Date(timeIntervalSince1970: 1_751_724_600.25),
            Date(timeIntervalSince1970: 253_402_300_799.875),
        ]
        let reference = ISO8601DateFormatter()
        reference.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expected = dates.map { reference.string(from: $0) }
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let value = driver.getValue(suiteName: "storage-suite", key: "key-\(index)")
            let dateIndex = index % dates.count
            let encoded = DefaultUserDefaultsDriver.encode(dates[dateIndex], as: .date)
            if value == nil, Data(encoded.utf8) == Data(expected[dateIndex].utf8) {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(calls.withLock { $0 }, 32)
        XCTAssertEqual(successes.withLock { $0 }, 32)
    }
}

final class StorageDateEncodingIdentityTests: XCTestCase {
    func testDateEncodingMatchesOriginalFormatterBytes() throws {
        try assertOriginalFormatterBytes()
    }

    func testDateEncodingMatchesOriginalFormatterBytesWithNonUTCDefaultTimeZone() throws {
        let originalTimeZone = NSTimeZone.default
        defer { NSTimeZone.default = originalTimeZone }
        NSTimeZone.default = try XCTUnwrap(TimeZone(secondsFromGMT: 19800))

        try assertOriginalFormatterBytes()
    }

    private func assertOriginalFormatterBytes() throws {
        let reference = ISO8601DateFormatter()
        reference.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let dates = [
            Date(timeIntervalSince1970: 0),
            Date(timeIntervalSince1970: 0.0004),
            Date(timeIntervalSince1970: 0.9996),
            Date(timeIntervalSince1970: -1.125),
            Date(timeIntervalSince1970: -2_208_988_800.875),
            Date(timeIntervalSince1970: 1_751_724_600.25),
            Date(timeIntervalSince1970: 32_503_680_000.123),
            Date(timeIntervalSince1970: 253_402_300_799.875),
        ]

        for date in dates {
            let expected = reference.string(from: date)
            let encoded = DefaultUserDefaultsDriver.encode(date, as: .date)
            XCTAssertEqual(Data(encoded.utf8), Data(expected.utf8))
            XCTAssertTrue(encoded.hasSuffix("Z"))

            let array = DefaultUserDefaultsDriver.encode([date], as: .array)
            let expectedArray = try JSONSerialization.data(withJSONObject: [expected], options: [.sortedKeys])
            XCTAssertEqual(Data(array.utf8), expectedArray)

            let dictionary = DefaultUserDefaultsDriver.encode(["date": date], as: .dictionary)
            let expectedDictionary = try JSONSerialization.data(
                withJSONObject: ["date": expected], options: [.sortedKeys]
            )
            XCTAssertEqual(Data(dictionary.utf8), expectedDictionary)
        }
    }
}
