@testable import AutoMobilePrototypeAgentCore
import CoreGraphics
import Foundation
import ImageIO
import XCTest

final class PrototypeLibraryImportTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/app/library")
    private let storage = URL(fileURLWithPath: "/app/storage")
    private let spec = Data("""
    {"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}
    """.utf8)
    private let png = Data([137, 80, 78, 71, 13, 10, 26, 10])

    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
        do {
            try PrototypeSpecStrictValidator.validate(data: Data("""
            {"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}
            """.utf8))
        } catch { XCTFail("Warmup: \(error)") }
    }

    private func store(_ files: PrototypeLibraryFakeFileSystem) throws -> PrototypeLibraryStore {
        var sequence = 0
        return try PrototypeLibraryStore(
            root: root, storageRoot: storage, files: files, clock: PrototypeLibraryFakeClock(), libraryId: {
                sequence += 1
                return String(format: "00000000-0000-0000-0000-%012d", sequence)
            }
        )
    }

    private func imageSpec(_ count: Int = 1) throws -> Data {
        try JSONEncoder().encode([
            "id": JSONValue.string("images"),
            "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "root": .object([
                "type": .string("column"), "children": .array((0 ..< count).map {
                    .object(["type": .string("image"), "asset": .string("image\($0)")])
                }),
            ]),
        ])
    }

    private func imageBundle(_ count: Int = 1, type: String = "image/png", bytes: Data? = nil) throws -> Data {
        try PrototypeBundle.export(.init(
            spec: imageSpec(count), assets: { _ in .init(mediaType: type, bytes: bytes ?? self.png) },
            fonts: { _ in nil }
        ))
    }

    private func assertEmpty(
        _ files: PrototypeLibraryFakeFileSystem,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(files.data.isEmpty, file: file, line: line)
        XCTAssertEqual(files.directories, [root.path, storage.path], file: file, line: line)
    }

    func testBareAndBundleImportUseAppProvenanceNewIdentityAndEmptyStorage() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let importer = PrototypeLibraryImporter(store: library)
        let archive = try PrototypeBundle.export(.init(spec: spec, assets: { _ in nil }, fonts: { _ in nil }))
        let first = try importer.importData(spec, source: .file)
        let second = try importer.importData(archive, source: .share)
        let third = try importer.importData(spec, source: .paste)
        XCTAssertEqual([first.source, second.source, third.source], [.file, .share, .paste])
        XCTAssertEqual(first.label, "demo")
        XCTAssertNotEqual(first.libraryId, "demo")
        XCTAssertNotEqual(first.libraryId, second.libraryId)
        XCTAssertEqual(try library.list().entries.count, 3)
        for entry in [first, second, third] {
            XCTAssertEqual(try library.load(entry.libraryId).spec, spec)
            XCTAssertEqual(try files.children(library.storageURL(entry.libraryId)), [])
        }
    }

    func testSizeCapsRunBeforeParsingOrAnyFileSystemAccess() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let importer = try PrototypeLibraryImporter(store: store(files))
        let calls = files.calls
        var zip = Data([80, 75, 3, 4])
        zip.append(Data(repeating: 0, count: PrototypeBundle.maxCompressedBytes - 3))
        for bytes in [Data(repeating: 0, count: PrototypeBundle.maxSpecBytes + 1), zip] {
            XCTAssertThrowsError(try importer.importData(bytes, source: .file)) {
                XCTAssertEqual(
                    $0 as? PrototypeLibraryImportFailure,
                    .invalid(path: "$", message: "Import byte cap exceeded")
                )
            }
        }
        XCTAssertEqual(files.calls, calls)
        assertEmpty(files)
    }

    func testInvalidSpecAndDuplicateKeysRejectWholeImportWithPath() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let importer = try PrototypeLibraryImporter(store: store(files))
        let invalid = Data("""
        {"id":"bad","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi","oops":1}}
        """.utf8)
        XCTAssertThrowsError(try importer.importData(invalid, source: .file)) {
            XCTAssertTrue(($0 as? PrototypeLibraryImportFailure)?.path.contains("oops") == true)
        }
        let manifest = Data("""
        {"bundleFormatVersion":1,"specSha256":"\(PrototypeBundle.sha256(invalid))","assets":[],"fonts":[],"requires":[]}
        """.utf8)
        let archive = PrototypeBundleZipWriter.write([("bundle.json", manifest), ("spec.json", invalid)])
        XCTAssertThrowsError(try importer.importData(archive, source: .share)) {
            XCTAssertTrue(($0 as? PrototypeLibraryImportFailure)?.path.contains("oops") == true)
        }
        XCTAssertThrowsError(try importer.importData(Data(#"{"id":"a","id":"b"}"#.utf8), source: .share)) {
            XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "$")
        }
        assertEmpty(files)
    }

    func testBareImageAndFontReferencesRejectWithOffendingID() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let importer = try PrototypeLibraryImporter(store: store(files))
        XCTAssertThrowsError(try importer.importData(imageSpec(), source: .file)) {
            XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "image0")
        }
        let fontSpec = Data("""
        {"id":"font","window":{"placement":{"type":"fullscreen"}},
        "root":{"type":"text","text":"Hello","style":{"fontFamily":{"asset":"face"}}}}
        """.utf8)
        XCTAssertThrowsError(try importer.importData(fontSpec, source: .file)) {
            XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "face")
        }
        assertEmpty(files)
    }

    func testBundleMissingImageFontAndManifestEntryRejectWholeImport() throws {
        for name in ["missing-image", "missing-font", "manifest-without-zip", "manifest-extra-source"] {
            let files = PrototypeLibraryFakeFileSystem()
            let importer = try PrototypeLibraryImporter(store: store(files))
            let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases.first { $0.name == name })
            XCTAssertThrowsError(try importer.importData(fixture.bundleBase64, source: .share)) {
                XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, fixture.path)
            }
            assertEmpty(files)
        }
    }

    func testCapabilityFailureNamesMissingCapabilitiesAndIgnoresAdvisoryManifestRequires() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let importer = PrototypeLibraryImporter(store: library, supportedCapabilities: [])
        let dataSpec = Data("""
        {"id":"data","window":{"placement":{"type":"fullscreen"}},"data":{},
        "root":{"type":"text","text":"Hi"}}
        """.utf8)
        let archive = try PrototypeBundle.export(.init(spec: dataSpec, assets: { _ in nil }, fonts: { _ in nil }))
        for bytes in [dataSpec, archive] {
            XCTAssertThrowsError(try importer.importData(bytes, source: .file)) {
                XCTAssertEqual(
                    $0 as? PrototypeLibraryImportFailure,
                    .needsNewerViewer(missing: ["prototype_data_model_v1"])
                )
            }
        }
        assertEmpty(files)
        let bundle = PrototypeBundle(spec: spec, assets: [:], fonts: [:], requires: ["prototype_future_v1"])
        let advisory = try PrototypeBundleZipWriter.write(PrototypeBundle.canonicalFiles(
            .init(spec: bundle.spec, assets: { _ in nil }, fonts: { _ in nil }), requires: bundle.requires
        ))
        XCTAssertNoThrow(try importer.importData(advisory, source: .file))
    }

    func testImageBudgetsRejectZeroOversizedOverflowAndProbeFailuresBeforeCommit() throws {
        for size in [
            PrototypeLibraryImageSize(width: 0, height: 1),
            .init(width: 1, height: 0),
            .init(width: 4001, height: 4000),
            .init(width: Int.max, height: Int.max),
        ] {
            let files = PrototypeLibraryFakeFileSystem()
            let probe = PrototypeLibraryFakeImageProbe(size: size)
            let importer = try PrototypeLibraryImporter(store: store(files), imageProbe: probe)
            XCTAssertThrowsError(try importer.importData(imageBundle(), source: .file)) {
                XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "assets/image0")
            }
            XCTAssertEqual(probe.calls, 1)
            assertEmpty(files)
        }
        let files = PrototypeLibraryFakeFileSystem()
        let probe = PrototypeLibraryFakeImageProbe()
        probe.fails = true
        XCTAssertThrowsError(
            try PrototypeLibraryImporter(store: store(files), imageProbe: probe)
                .importData(imageBundle(), source: .file)
        )
        assertEmpty(files)
    }

    func testAggregatePixelBudgetAndExactBoundary() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let probe = PrototypeLibraryFakeImageProbe(size: .init(width: 4000, height: 4000))
        let importer = try PrototypeLibraryImporter(store: store(files), imageProbe: probe)
        XCTAssertThrowsError(try importer.importData(imageBundle(5), source: .file)) {
            XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "assets/image4")
        }
        assertEmpty(files)
        XCTAssertNoThrow(try importer.importData(imageBundle(4), source: .file))
    }

    func testPNGJPEGAndWebPMagicAllowlistUsesProbeAndRejectsBadMagicBeforeProbe() throws {
        for (type, bytes) in [
            ("image/png", png),
            ("image/jpeg", Data([255, 216, 255])),
            ("image/webp", Data("RIFF0000WEBP".utf8)),
        ] {
            let files = PrototypeLibraryFakeFileSystem()
            let probe = PrototypeLibraryFakeImageProbe()
            let importer = try PrototypeLibraryImporter(store: store(files), imageProbe: probe)
            XCTAssertNoThrow(try importer.importData(imageBundle(type: type, bytes: bytes), source: .file))
            XCTAssertEqual(probe.calls, 1)
        }
        let files = PrototypeLibraryFakeFileSystem()
        let probe = PrototypeLibraryFakeImageProbe()
        let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases.first { $0.name == "wrong-media-magic" })
        XCTAssertThrowsError(
            try PrototypeLibraryImporter(store: store(files), imageProbe: probe)
                .importData(fixture.bundleBase64, source: .file)
        )
        XCTAssertEqual(probe.calls, 0)
        assertEmpty(files)
    }

    func testLibraryByteCapAndFailedCommitLeaveNoFiles() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let importer = try PrototypeLibraryImporter(store: store(files))
        files.sizes[root.path] = PrototypeLibraryStore.maxBytes
        XCTAssertThrowsError(try importer.importData(spec, source: .file))
        assertEmpty(files)
        files.sizes.removeAll()
        files.failWrite = true
        XCTAssertThrowsError(try importer.importData(spec, source: .file))
        assertEmpty(files)
    }

    func testLibraryEntryCapRefusesImportBeforeStaging() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let importer = try PrototypeLibraryImporter(store: store(files))
        for index in 1 ... PrototypeLibraryStore.maxEntries {
            try files.createDirectory(root.appendingPathComponent(String(
                format: "00000000-0000-0000-0000-%012d",
                index
            )))
        }
        let before = files.directories
        XCTAssertThrowsError(try importer.importData(spec, source: .file)) {
            XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, "library")
        }
        XCTAssertEqual(files.directories, before)
        XCTAssertTrue(files.data.isEmpty)
    }

    func testOrphanedStorageCannotBeReusedByAnImport() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let orphan = storage.appendingPathComponent("00000000-0000-0000-0000-000000000001")
        try files.createDirectory(orphan)
        files.data[orphan.appendingPathComponent("values.json").path] = Data([1])
        let before = files.data
        XCTAssertThrowsError(try PrototypeLibraryImporter(store: library).importData(spec, source: .file))
        XCTAssertEqual(try files.children(root), [])
        XCTAssertEqual(files.data, before)
    }

    func testStrictValidatorRejectsSecureAndPasswordBindingsInRequestsAndStorage() throws {
        for secure in [true, false] {
            let field: [String: JSONValue] = [
                "type": .string("textField"), "stateKey": .string("password"),
                secure ? "secure" : "keyboardType": secure ? .bool(true) : .string("password"),
            ]
            for slot in ["url", "headers", "query", "body", "storage"] {
                let files = PrototypeLibraryFakeFileSystem()
                let importer = try PrototypeLibraryImporter(store: store(files))
                var request: [String: JSONValue] = [
                    "type": .string("request"), "via": .string("device"), "method": .string("POST"),
                    "url": .string("https://example.test/feed"),
                ]
                switch slot {
                case "url": request[slot] = .string("https://example.test/{password}")
                case "headers", "query": request[slot] = .object(["token": .object(["state": .string("password")])])
                case "body": request[slot] = .object(["state": .string("password")])
                default: break
                }
                var fields: [String: JSONValue] = [
                    "id": .string("secure"), "state": .object(["password": .string("")]),
                    "window": .object(["placement": .object(["type": .string("fullscreen")])]),
                    "root": .object(["type": .string("column"), "children": .array([
                        .object(field), .object([
                            "type": .string("button"),
                            "label": .string("Go"),
                            "onTap": .array([.object(request)]),
                        ]),
                    ])]),
                ]
                if slot ==
                    "storage"
                {
                    fields[slot] = .object(["version": .number(1), "keys": .array([.string("state:password")])])
                }
                let data = try JSONEncoder().encode(fields)
                var expectedPath: String?
                XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, library: true)) {
                    guard case let PrototypeLoadError.invalidSpec(path, _) = $0 else {
                        return XCTFail("Unexpected strict error: \($0)")
                    }
                    expectedPath = path
                    XCTAssertTrue(path.contains(slot), "\(slot): \(path)")
                }
                XCTAssertThrowsError(try importer.importData(data, source: .file)) {
                    XCTAssertEqual(($0 as? PrototypeLibraryImportFailure)?.path, expectedPath)
                }
                assertEmpty(files)
            }
        }
    }

    func testImageIOReadsGeneratedPNGHeaderAndRefusesTruncatedHeader() throws {
        let pixels = Data([255, 0, 0, 255])
        let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
        let image = try XCTUnwrap(CGImage(
            width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ))
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            bytes as CFMutableData, "public.png" as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        XCTAssertEqual(try PrototypeLibraryImageIOProbe().dimensions(bytes as Data), .init(width: 1, height: 1))
        XCTAssertThrowsError(try PrototypeLibraryImageIOProbe().dimensions(png))
    }
}

final class PrototypeLibraryFakeImageProbe: ImageHeaderProbe {
    var size: PrototypeLibraryImageSize
    var calls = 0
    var fails = false
    init(size: PrototypeLibraryImageSize = .init(width: 1, height: 1)) { self.size = size }
    func dimensions(_: Data) throws -> PrototypeLibraryImageSize {
        calls += 1
        if fails { throw PrototypeLibraryFailure(path: "probe", message: "Unreadable") }
        return size
    }
}
