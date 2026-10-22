@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleDeflateTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
    }

    private func probe(suffix: [UInt8] = [], truncate: Bool = false) throws -> Data {
        let fixture = try PrototypeBundleFixtures.corpus.get().cases[4].bundleBase64
        let directory = PrototypeBundleZipDirectory(bytes: Array(fixture))
        let entry = try XCTUnwrap(directory.read().first)
        let expanded = try XCTUnwrap(PrototypeBundleZipReader.read(fixture).first?.1)
        var compressed = Array(directory.bytes[entry.start ..< entry.end])
        if truncate { compressed.removeLast() }
        compressed += suffix
        // Preserve canonical ZIP framing while substituting one raw DEFLATE entry.
        var bytes = Array(PrototypeBundleZipWriter.write([("bundle.json", expanded)]))
        let start = 30 + "bundle.json".utf8.count
        bytes.replaceSubrange(start ..< start + expanded.count, with: compressed)
        let central = start + compressed.count
        let end = bytes.count - 22
        put(&bytes, 8, 8, width: 2)
        put(&bytes, 18, compressed.count)
        put(&bytes, central + 10, 8, width: 2)
        put(&bytes, central + 20, compressed.count)
        put(&bytes, end + 16, central)
        return Data(bytes)
    }

    private func put(_ bytes: inout [UInt8], _ offset: Int, _ value: Int, width: Int = 4) {
        for index in 0 ..< width {
            bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (8 * index))
        }
    }

    func testValidRawStreamConsumesItsLastByte() throws {
        XCTAssertEqual(try PrototypeBundleZipReader.read(probe()).count, 1)
    }

    func testRawStreamMissingLastByteRejects() throws {
        XCTAssertThrowsError(try PrototypeBundleZipReader.read(probe(truncate: true))) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.sizeMismatch, "bundle.json"))
        }
    }

    func testUnusedInputOfVaryingLengthsRejectsDespiteDecoderReadAhead() throws {
        for count in [1, 2, 8, 32, 1024] {
            XCTAssertThrowsError(try PrototypeBundleZipReader.read(probe(suffix: Array(repeating: 0, count: count)))) {
                XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.sizeMismatch, "bundle.json"))
            }
        }
    }
}
