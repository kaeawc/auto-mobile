import Foundation
import XCTest

/// Differential parity for `DefaultStorageInspecting` (Phase 3). Populates a scratch
/// UserDefaults suite with one value of every supported kind — exercising the subtle
/// `detectType` path (CFBoolean vs CFNumber int/double) and `stringValue` formatting —
/// then asserts the reference and rewrite report identical `(value, type)` per key,
/// identical bulk `getEntries` for those keys, and the same `listSuites()` names.
///
/// The rewrite dropped the reference's never-called `registerSuite`; `listSuites()`
/// therefore reports only the Standard suite, which is exactly what production always
/// produced (the mutable list was always empty). This test pins that equivalence.
final class StorageInspectingParityTests: XCTestCase {
    private let suite = "com.ctrlproxy.rewrite.storageparity.test"

    private var knownKeys: [String] {
        ["k_string", "k_int", "k_double", "k_bool", "k_data", "k_date", "k_array", "k_dict"]
    }

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        guard let defaults = UserDefaults(suiteName: suite) else {
            XCTFail("could not open scratch suite")
            return
        }
        defaults.set("hello", forKey: "k_string")
        defaults.set(42, forKey: "k_int")
        defaults.set(3.14, forKey: "k_double")
        defaults.set(true, forKey: "k_bool")
        defaults.set(Data([0x01, 0x02, 0x03]), forKey: "k_data")
        defaults.set(Date(timeIntervalSince1970: 1_730_000_000), forKey: "k_date")
        defaults.set(["a", "b"], forKey: "k_array")
        defaults.set(["k": "v"], forKey: "k_dict")
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testPerKeyEntryParity() {
        for key in knownKeys {
            let reference = ReferenceStorage.entry(suite: suite, key: key)
            let rewrite = RewriteStorage.entry(suite: suite, key: key)
            XCTAssertNotNil(rewrite, "rewrite returned nil for \(key)")
            XCTAssertEqual(reference, rewrite, "getEntry diverged for \(key)")
        }

        // Sanity: the tricky type classifications actually landed as expected.
        XCTAssertEqual(RewriteStorage.entry(suite: suite, key: "k_bool")?["type"], "BOOLEAN")
        XCTAssertEqual(RewriteStorage.entry(suite: suite, key: "k_int")?["type"], "INT")
        XCTAssertEqual(RewriteStorage.entry(suite: suite, key: "k_double")?["type"], "DOUBLE")
    }

    func testBulkEntriesParityForKnownKeys() {
        let known = Set(knownKeys)
        let reference = ReferenceStorage.entries(suite: suite).filter { known.contains($0["key"] ?? "") }
        let rewrite = RewriteStorage.entries(suite: suite).filter { known.contains($0["key"] ?? "") }
        XCTAssertEqual(reference.count, knownKeys.count, "reference did not report all known keys")
        XCTAssertEqual(reference, rewrite, "getEntries diverged for the known keys")
    }

    func testMissingKeyIsNilInBoth() {
        XCTAssertNil(ReferenceStorage.entry(suite: suite, key: "does_not_exist"))
        XCTAssertNil(RewriteStorage.entry(suite: suite, key: "does_not_exist"))
    }

    func testListSuitesReportsStandardInBoth() {
        XCTAssertEqual(ReferenceStorage.suiteNames(), ["Standard"])
        XCTAssertEqual(RewriteStorage.suiteNames(), ["Standard"])
    }
}
