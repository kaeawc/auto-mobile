@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeViewerLayoutTests: XCTestCase {
    private final class FakeReader: PrototypeViewerLayoutReading {
        let result: PrototypeSavedLoadResult
        var directories: [URL] = []
        init(_ result: PrototypeSavedLoadResult) { self.result = result }
        func load(directory: URL) -> PrototypeSavedLoadResult {
            directories.append(directory)
            return result
        }
    }

    private final class FakeFallback: PrototypeViewerContentLoading {
        let content: PrototypeViewerContent
        var calls = 0
        init(_ content: PrototypeViewerContent = .none) { self.content = content }
        func load() -> PrototypeViewerContent {
            calls += 1
            return content
        }
    }

    @MainActor
    private final class FakeRegistrar: PrototypeAssetRegistering {
        var images: [String: Data] = [:]
        var fonts: [String: Data] = [:]
        var rejected: Set<String> = []
        func registerImage(id: String, data: Data) -> Bool {
            images[id] = data
            return !rejected.contains(id)
        }

        func registerFont(id: String, data: Data) -> String? {
            fonts[id] = data
            return rejected.contains(id) ? nil : "PS-\(id)"
        }
    }

    private let directory = URL(fileURLWithPath: "/fake/Documents/prototype", isDirectory: true)

    private func saved(
        root: String = #"{"type":"text","text":"Hello"}"#,
        assets: [String: PrototypeSavedAsset] = [:], problems: [PrototypeSavedProblem] = []
    )
        throws -> PrototypeSavedPrototype
    {
        let data = Data("""
        {
          "id": "saved",
          "window": {"placement": {"type": "fullscreen"}},
          "root": \(root)
        }
        """.utf8)
        return try PrototypeSavedPrototype(
            spec: JSONDecoder().decode(PrototypeSpec.self, from: data),
            specData: data, assets: assets, problems: problems
        )
    }

    private func asset(_ id: String, font: Bool = false) -> PrototypeSavedAsset {
        PrototypeSavedAsset(
            id: id, mediaType: font ? "font/ttf" : "image/png", isFont: font,
            sha256: "fake", data: Data(id.utf8)
        )
    }

    @MainActor
    func testLoadedRegistersEveryAssetAndPreservesProblems() async throws {
        let problem = PrototypeSavedProblem(assetId: "missing", kind: .missing, detail: "absent")
        let value = try saved(
            assets: ["image": asset("image"), "font": asset("font", font: true)], problems: [problem]
        )
        let reader = FakeReader(.loaded(value))
        let fallback = FakeFallback()
        let registrar = FakeRegistrar()
        let launch = PrototypeViewerLayoutLoader(reader: reader, fallback: fallback, registrar: registrar)
            .load(directory: directory)
        guard case let .loaded(spec, bytes) = launch.content else { return XCTFail("Expected saved layout") }
        XCTAssertTrue(launch.fromSavedLayout)
        XCTAssertEqual(spec.id, "saved")
        XCTAssertEqual(bytes, try prototypeViewerCompactSpecBytes(value.specData))
        XCTAssertLessThan(bytes, value.specData.count)
        XCTAssertEqual(reader.directories, [directory])
        XCTAssertEqual(fallback.calls, 0)
        XCTAssertEqual(registrar.images, ["image": Data("image".utf8)])
        XCTAssertEqual(registrar.fonts, ["font": Data("font".utf8)])
        XCTAssertEqual(launch.registeredImageIds, ["image"])
        XCTAssertEqual(launch.fontFaces, ["font": "PS-font"])
        XCTAssertEqual(launch.problems.map(\.wireObject), [problem.wireObject])
    }

    @MainActor
    func testRejectedAssetsAreUnreadableAndOthersStillRegister() async throws {
        let problem = PrototypeSavedProblem(assetId: "absent", kind: .missing, detail: "missing file")
        let value = try saved(
            assets: [
                "badImage": asset("badImage"), "badFont": asset("badFont", font: true),
                "image": asset("image"), "font": asset("font", font: true),
            ], problems: [problem]
        )
        let registrar = FakeRegistrar()
        registrar.rejected = ["badImage", "badFont"]
        let launch = PrototypeViewerLayoutLoader(
            reader: FakeReader(.loaded(value)), fallback: FakeFallback(), registrar: registrar
        ).load(directory: directory)
        XCTAssertTrue(launch.fromSavedLayout)
        XCTAssertEqual(Set(registrar.images.keys), ["badImage", "image"])
        XCTAssertEqual(Set(registrar.fonts.keys), ["badFont", "font"])
        XCTAssertEqual(launch.registeredImageIds, ["image"])
        XCTAssertEqual(launch.fontFaces, ["font": "PS-font"])
        XCTAssertEqual(launch.problems.map(\.assetId), ["absent", "badFont", "badImage"])
        XCTAssertEqual(launch.problems.map(\.kind), [.missing, .unreadable, .unreadable])
        XCTAssertTrue(launch.problems.allSatisfy { !$0.detail.isEmpty })
    }

    @MainActor
    func testUnreadableAssetSortsBeforeExistingReaderProblem() async throws {
        let problem = PrototypeSavedProblem(assetId: "z", kind: .missing, detail: "missing file")
        let value = try saved(assets: ["a": asset("a", font: true)], problems: [problem])
        let registrar = FakeRegistrar()
        registrar.rejected = ["a"]
        let launch = PrototypeViewerLayoutLoader(
            reader: FakeReader(.loaded(value)), fallback: FakeFallback(), registrar: registrar
        ).load(directory: directory)
        XCTAssertTrue(launch.fontFaces.isEmpty)
        XCTAssertEqual(launch.problems.map(\.assetId), ["a", "z"])
        XCTAssertEqual(launch.problems.map(\.kind), [.unreadable, .missing])
        XCTAssertEqual(launch.problems.last?.wireObject, problem.wireObject)
    }

    @MainActor
    func testNotFoundUsesBundledDemoOrNone() async throws {
        let value = try saved()
        let fallback = FakeFallback(.loaded(value.spec, specBytes: 123))
        let registrar = FakeRegistrar()
        let launch = PrototypeViewerLayoutLoader(
            reader: FakeReader(.notFound), fallback: fallback, registrar: registrar
        ).load(directory: directory)
        guard case let .loaded(spec, bytes) = launch.content else { return XCTFail("Expected bundled demo") }
        XCTAssertEqual(spec.id, "saved")
        XCTAssertFalse(launch.fromSavedLayout)
        XCTAssertEqual(bytes, 123)
        XCTAssertEqual(fallback.calls, 1)
        XCTAssertTrue(launch.registeredImageIds.isEmpty)
        XCTAssertTrue(launch.fontFaces.isEmpty)
        XCTAssertTrue(launch.problems.isEmpty)
        let absent = FakeFallback()
        let empty = PrototypeViewerLayoutLoader(
            reader: FakeReader(.notFound), fallback: absent, registrar: registrar
        ).load(directory: directory)
        guard case .none = empty.content else { return XCTFail("Expected none") }
        XCTAssertFalse(empty.fromSavedLayout)
        XCTAssertEqual(absent.calls, 1)
        XCTAssertTrue(registrar.images.isEmpty)
        XCTAssertTrue(registrar.fonts.isEmpty)
    }

    @MainActor
    func testUnsupportedAndCorruptNeverConsultFallback() async {
        let fallback = FakeFallback()
        let registrar = FakeRegistrar()
        let unsupported = PrototypeViewerLayoutLoader(
            reader: FakeReader(.unsupportedFormat(version: 2)), fallback: fallback, registrar: registrar
        ).load(directory: directory)
        guard case let .unsupportedFormat(version) = unsupported.content else { return XCTFail("Expected unsupported") }
        XCTAssertFalse(unsupported.fromSavedLayout)
        XCTAssertEqual(version, 2)
        let corrupt = PrototypeViewerLayoutLoader(
            reader: FakeReader(.corrupt("x")), fallback: fallback, registrar: registrar
        ).load(directory: directory)
        guard case let .corrupt(message) = corrupt.content else { return XCTFail("Expected corrupt") }
        XCTAssertFalse(corrupt.fromSavedLayout)
        XCTAssertEqual(message, "x")
        XCTAssertEqual(fallback.calls, 0)
        XCTAssertTrue(registrar.images.isEmpty)
        XCTAssertTrue(registrar.fonts.isEmpty)
    }

    @MainActor
    func testUnresolvedAnchorIsInvalidBeforeRegistration() async throws {
        let value = try saved(
            root: #"{"type":"text","text":"Hello","anchor":{"type":"element","selector":{"text":"General"}}}"#,
            assets: ["image": asset("image")]
        )
        let fallback = FakeFallback()
        let registrar = FakeRegistrar()
        let launch = PrototypeViewerLayoutLoader(
            reader: FakeReader(.loaded(value)), fallback: fallback, registrar: registrar
        ).load(directory: directory)
        guard case let .invalid(path, message) = launch.content else { return XCTFail("Expected invalid anchor") }
        XCTAssertFalse(launch.fromSavedLayout)
        XCTAssertEqual(path, "root.anchor")
        XCTAssertEqual(message, "Element anchors must be resolved to bounds by the host")
        XCTAssertEqual(fallback.calls, 0)
        XCTAssertTrue(registrar.images.isEmpty)
    }

    func testProblemWireObject() {
        for kind in [
            PrototypeSavedProblemKind.missing, .hashMismatch, .oversized, .unreadable, .unsafePath,
        ] {
            let problem = PrototypeSavedProblem(assetId: "logo", kind: kind, detail: "reason")
            XCTAssertEqual(problem.wireObject, ["assetId": "logo", "kind": kind.rawValue, "detail": "reason"])
        }
    }
}
