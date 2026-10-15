import Foundation
import XCTest

enum JSONGolden {
    /// Parse `data` to a JSON object, optionally dropping a live-`Date()` top-level `timestamp`.
    static func object(
        _ data: Data,
        strippingTimestamp: Bool = false,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        -> [String: Any]?
    {
        guard var dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            XCTFail("not a JSON object: \(String(decoding: data, as: UTF8.self))", file: file, line: line)
            return nil
        }
        if strippingTimestamp {
            dict.removeValue(forKey: "timestamp")
        }
        return dict
    }

    /// Decode `input` and re-encode with sorted keys through `reencode`, then assert the
    /// round-trip is idempotent and preserves every wire field the input carried.
    static func assertReencodePreservesWire(
        _ reencode: (Data) throws -> Data,
        input: String,
        stripTimestamp: Bool = false,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let inputData = Data(input.utf8)
        do {
            let once = try reencode(inputData)
            let twice = try reencode(once)
            XCTAssertEqual(
                once, twice,
                "\(label): re-encode is not idempotent (unstable field handling)",
                file: file, line: line
            )
            guard let inputObject = object(inputData, strippingTimestamp: stripTimestamp, file: file, line: line),
                  let outputObject = object(once, strippingTimestamp: stripTimestamp, file: file, line: line)
            else { return }
            assertContains(outputObject, contains: inputObject, context: label, file: file, line: line)
        } catch {
            XCTFail("\(label): re-encode threw \(error)", file: file, line: line)
        }
    }

    /// Every field in `subset` appears in `superset` with a deep-equal value. `superset` may
    /// carry additional fields (a defaulted field the wire omitted). NSNull-aware; recurses
    /// through nested objects and arrays.
    static func assertContains(
        _ superset: [String: Any],
        contains subset: [String: Any],
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (key, expected) in subset {
            // An explicit `null` for an optional is wire-equivalent to omitting it, and the model
            // omits nil optionals on encode — so a null input field need not appear in the output.
            if expected is NSNull { continue }
            guard let actual = superset[key] else {
                XCTFail(
                    "\(context): field `\(key)` missing from re-encoded output (drop/rename)",
                    file: file,
                    line: line
                )
                continue
            }
            assertValueEqual(expected: expected, actual: actual, context: "\(context).\(key)", file: file, line: line)
        }
    }

    private static func assertValueEqual(
        expected: Any,
        actual: Any,
        context: String,
        file: StaticString,
        line: UInt
    ) {
        if let expectedDict = expected as? [String: Any] {
            guard let actualDict = actual as? [String: Any] else {
                XCTFail("\(context): expected object, got \(actual)", file: file, line: line)
                return
            }
            assertContains(actualDict, contains: expectedDict, context: context, file: file, line: line)
            return
        }
        if let expectedArray = expected as? [Any] {
            guard let actualArray = actual as? [Any] else {
                XCTFail("\(context): expected array, got \(actual)", file: file, line: line)
                return
            }
            XCTAssertEqual(actualArray.count, expectedArray.count, "\(context): array length", file: file, line: line)
            for (index, pair) in zip(expectedArray, actualArray).enumerated() {
                assertValueEqual(
                    expected: pair.0,
                    actual: pair.1,
                    context: "\(context)[\(index)]",
                    file: file,
                    line: line
                )
            }
            return
        }
        XCTAssertTrue(
            (actual as AnyObject).isEqual(expected),
            "\(context): re-encoded \(actual) != wire \(expected)",
            file: file, line: line
        )
    }
}
