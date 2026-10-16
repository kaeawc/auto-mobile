@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The file-backed store against a temp directory: real files, no UIKit.
final class PrototypeFileStorageStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("prototype-storage-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private var directory: URL { root.appendingPathComponent("storage", isDirectory: true) }

    private func store() -> FilePrototypeStorageStore {
        FilePrototypeStorageStore(directory: directory)
    }

    private func files() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    func testSaveCreatesTheDirectoryAndLoadReadsTheValuesBack() throws {
        let values: [String: JSONValue] = [
            "state:dark": .bool(true),
            "data:/cart": .object(["items": .array([.string("a/b"), .number(2)])]),
        ]
        try store().save(PrototypeStoredValues(version: 3, values: values), id: "shop")
        XCTAssertEqual(files(), ["shop.json"])
        let loaded = try store().load(id: "shop")
        XCTAssertEqual(loaded, PrototypeStoredValues(version: 3, values: values))
    }

    func testSaveReplacesAtomicallyAndLeavesNoTemporaryFile() throws {
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .number(1)]), id: "p")
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .number(2)]), id: "p")
        XCTAssertEqual(try store().load(id: "p")?.values["state:a"], .number(2))
        XCTAssertEqual(files(), ["p.json"])
    }

    func testLoadOfAnUnknownIdIsNilAndDeleteOfOneSucceeds() throws {
        XCTAssertNil(try store().load(id: "none"))
        XCTAssertNoThrow(try store().delete(id: "none"))
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .bool(true)]), id: "p")
        try store().delete(id: "p")
        XCTAssertNil(try store().load(id: "p"))
        XCTAssertEqual(files(), [])
    }

    func testIdsCannotEscapeTheDirectoryOrCollideAfterSanitizing() throws {
        let hostile = ["../../escape", "a/b", "..", ".", ".hidden", "a b", "a%2Fb", "é", ""]
        for (index, id) in hostile.enumerated() {
            try store().save(PrototypeStoredValues(version: 1, values: ["state:n": .number(Double(index))]), id: id)
        }
        XCTAssertEqual(files().count, hostile.count, "every id has its own file: \(files())")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("escape.json").path))
        for (index, id) in hostile.enumerated() {
            XCTAssertEqual(try store().load(id: id)?.values["state:n"], .number(Double(index)), id)
        }
        XCTAssertEqual(FilePrototypeStorageStore.fileName(for: "a/b"), "a%2Fb")
        XCTAssertEqual(FilePrototypeStorageStore.fileName(for: "a%2Fb"), "a%252Fb")
        XCTAssertEqual(FilePrototypeStorageStore.fileName(for: ".."), "%2E%2E")
    }

    func testAVeryLongIdKeepsAShortDistinctFileName() throws {
        let one = String(repeating: "x", count: 400) + "1"
        let two = String(repeating: "x", count: 400) + "2"
        XCTAssertLessThan(FilePrototypeStorageStore.fileName(for: one).count, 140)
        XCTAssertNotEqual(FilePrototypeStorageStore.fileName(for: one), FilePrototypeStorageStore.fileName(for: two))
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .number(1)]), id: one)
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .number(2)]), id: two)
        XCTAssertEqual(try store().load(id: one)?.values["state:a"], .number(1))
        XCTAssertEqual(try store().load(id: two)?.values["state:a"], .number(2))
    }

    func testACorruptFileThrowsCorruptAndAnOversizedOneToo() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: store().fileURL(for: "bad"))
        XCTAssertThrowsError(try store().load(id: "bad")) { error in
            guard case PrototypeStorageError.corrupt = error else { return XCTFail("\(error)") }
        }
        try Data(#"{"id":"wrong","version":"x"}"#.utf8).write(to: store().fileURL(for: "shape"))
        XCTAssertThrowsError(try store().load(id: "shape"))
        try Data(count: FilePrototypeStorageStore.maxFileBytes + 1).write(to: store().fileURL(for: "big"))
        XCTAssertThrowsError(try store().load(id: "big"))
    }

    func testARecordForAnotherIdIsNotRestored() throws {
        try store().save(PrototypeStoredValues(version: 1, values: ["state:a": .bool(true)]), id: "owner")
        try FileManager.default.copyItem(at: store().fileURL(for: "owner"), to: store().fileURL(for: "imposter"))
        XCTAssertNil(try store().load(id: "imposter"))
    }

    func testTheDefaultDirectoryIsNamespacedUnderApplicationSupport() throws {
        let directory = try XCTUnwrap(FilePrototypeStorageStore.defaultDirectory())
        XCTAssertEqual(directory.lastPathComponent, "storage")
        XCTAssertEqual(directory.deletingLastPathComponent().lastPathComponent, "AutoMobilePrototypeAgent")
    }

    // MARK: Coordinator against real files

    private final class NoClock: PrototypeClock {
        var fires: [() -> Void] = []
        private final class Handle: PrototypeTimerHandle {
            func cancel() {}
        }

        func schedule(afterMilliseconds _: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
            fires.append(fire)
            return Handle()
        }
    }

    private func spec(_ id: String = "shop") throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":{"n":1},
         "storage":{"version":1,"keys":["state:n"]},
         "root":{"type":"column","children":[
           {"type":"button","label":"Bump","onTap":[{"type":"increment","key":"n"}]}]}}
        """.utf8))
    }

    func testValuesSurviveAProcessRestartThroughRealFiles() throws {
        let clock = NoClock()
        let first = PrototypeStorageCoordinator(store: store(), clock: clock, log: { _ in })
        var session = PrototypeSession()
        let prepared = try first.prepare(spec())
        session.show(prepared.spec, restoredState: prepared.state)
        let actions = try XCTUnwrap(session.spec?.root.children?.first?.onTap)
        _ = session.transition { $0.run(actions) }
        first.sessionChanged(session)
        _ = session.dismiss(reason: .agent)
        first.sessionChanged(session)
        XCTAssertEqual(files(), ["shop.json"])

        // A new coordinator over the same directory is a new process.
        let second = PrototypeStorageCoordinator(store: store(), clock: clock, log: { _ in })
        let restored = try second.prepare(spec())
        XCTAssertEqual(restored.state["n"], .number(2))
        XCTAssertEqual(try second.clear(id: "shop"), 1)
        XCTAssertEqual(files(), [])
    }
}
