@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleCommitTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
    }

    private func bundle(requires: [String]? = nil) throws -> PrototypeBundle {
        let original = try PrototypeBundle.read(PrototypeBundleFixtures.corpus.get().cases[1].bundleBase64)
        return .init(
            spec: original.spec,
            assets: original.assets,
            fonts: original.fonts,
            requires: requires ?? original.requires
        )
    }

    private var destination: URL { URL(fileURLWithPath: "/library/new") }

    func testAtomicCommitChecksModesAndWritesBeforeRename() throws {
        let fileSystem = FakeBundleFileSystem()
        XCTAssertEqual(
            try PrototypeBundleCommit.commit(bundle(), destination: destination, fileSystem: fileSystem).path,
            "/library/new"
        )
        XCTAssertEqual(fileSystem.operations.first, "directory /library")
        XCTAssertTrue(fileSystem.operations.contains("stage /library 448"))
        XCTAssertEqual(fileSystem.operations.last, "rename /library/.bundle-fake /library/new")
        XCTAssertEqual(fileSystem.files.count, 4)
        XCTAssertTrue(fileSystem.files.keys.allSatisfy { $0.hasPrefix("/library/new/") })
        XCTAssertEqual(fileSystem.operations.filter { $0.hasPrefix("rename ") }.count, 1)
    }

    private func cleanup(_ failure: String) throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.failOn = failure
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        )) {
            XCTAssertEqual(($0 as? PrototypeBundleStorageFailure)?.code, "storage_failure")
        }
        XCTAssertEqual(fileSystem.operations.last, "remove /library/.bundle-fake")
        XCTAssertTrue(fileSystem.files.isEmpty)
        XCTAssertFalse(fileSystem.directories.contains("/library/new"))
    }

    func testCleanupOnDirectoryFailure() throws { try cleanup("directory /library/.bundle-fake") }
    func testCleanupOnMkdirFailure() throws { try cleanup("mkdir /library/.bundle-fake/assets 448") }
    func testCleanupOnWriteFailure() throws { try cleanup("write /library/.bundle-fake/spec.json") }
    func testCleanupOnRenameFailure() throws { try cleanup("rename /library/.bundle-fake /library/new") }

    func testRejectSymlinkParentBeforeStaging() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.symlinks.insert("/library")
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertEqual(fileSystem.operations, ["directory /library"])
    }

    func testRejectDanglingDestinationSymlink() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.symlinks.insert("/library/new")
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertFalse(fileSystem.operations.contains { $0.hasPrefix("stage ") })
    }

    func testRejectPlantedLeafSymlinkAndCleanStage() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.symlinks.insert("/library/.bundle-fake/spec.json")
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertEqual(fileSystem.operations.last, "remove /library/.bundle-fake")
    }

    func testFailedStageCreationDoesNotDeleteExistingDirectory() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.directories.insert("/library/.bundle-fake")
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertFalse(fileSystem.operations.contains { $0.hasPrefix("remove ") })
    }

    func testCleanupFailureIsRetained() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.symlinks.insert("/library/.bundle-fake/spec.json")
        fileSystem.failOn = "remove /library/.bundle-fake"
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        )) {
            XCTAssertNotNil(($0 as? PrototypeBundleStorageFailure)?.cleanupMessage)
        }
    }

    func testAdvisoryRequiresArePreservedOnCommit() throws {
        let fileSystem = FakeBundleFileSystem()
        try PrototypeBundleCommit.commit(
            bundle(requires: ["future_capability_v2"]),
            destination: destination,
            fileSystem: fileSystem
        )
        let data = try XCTUnwrap(fileSystem.files["/library/new/bundle.json"])
        XCTAssertEqual(try PrototypeBundleManifest(data).requires, ["future_capability_v2"])
    }

    func testRevalidateBeforeCreatingStage() throws {
        let original = try bundle()
        let invalid = PrototypeBundle(spec: original.spec, assets: [:], fonts: [:], requires: original.requires)
        let fileSystem = FakeBundleFileSystem()
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            invalid,
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertFalse(fileSystem.operations.contains { $0.hasPrefix("stage ") })
    }

    func testInvalidStageLocationDoesNotRemoveUnownedDirectory() throws {
        let fileSystem = FakeBundleFileSystem()
        fileSystem.stagePath = "/elsewhere/stage"
        XCTAssertThrowsError(try PrototypeBundleCommit.commit(
            bundle(),
            destination: destination,
            fileSystem: fileSystem
        ))
        XCTAssertFalse(fileSystem.operations.contains { $0.hasPrefix("remove ") })
    }
}

private final class FakeBundleFileSystem: PrototypeBundleCommitFileSystem {
    enum Failure: Error { case injected, unsafe }
    var operations: [String] = []
    var directories: Set<String> = ["/library"]
    var symlinks = Set<String>()
    var files: [String: Data] = [:]
    var failOn: String?
    var stagePath = "/library/.bundle-fake"

    private func operation(_ name: String) throws {
        operations.append(name)
        if failOn == name { throw Failure.injected }
    }

    func assertRealDirectory(_ path: URL) throws {
        try operation("directory \(path.path)")
        guard directories.contains(path.path), !symlinks.contains(path.path) else { throw Failure.unsafe }
    }

    func assertAbsent(_ path: URL) throws {
        try operation("absent \(path.path)")
        guard !directories.contains(path.path), !symlinks.contains(path.path),
              files[path.path] == nil else { throw Failure.unsafe }
    }

    func makeStagingDirectory(parent: URL, mode: UInt16) throws -> URL {
        try operation("stage \(parent.path) \(mode)")
        guard directories.insert(stagePath).inserted else { throw Failure.unsafe }
        return URL(fileURLWithPath: stagePath)
    }

    func mkdir(_ path: URL, mode: UInt16) throws {
        try operation("mkdir \(path.path) \(mode)")
        guard mode == 0o700, !symlinks.contains(path.path),
              directories.insert(path.path).inserted else { throw Failure.unsafe }
    }

    func writeExclusiveNoFollow(_ path: URL, bytes: Data) throws {
        try operation("write \(path.path)")
        guard !symlinks.contains(path.path), files[path.path] == nil else { throw Failure.unsafe }
        files[path.path] = bytes
    }

    func rename(from: URL, to destination: URL) throws {
        try operation("rename \(from.path) \(destination.path)")
        files = Dictionary(uniqueKeysWithValues: files.map { (
            $0.key.replacingOccurrences(of: from.path, with: destination.path),
            $0.value
        ) })
        directories.insert(destination.path)
        directories.remove(from.path)
    }

    func remove(_ path: URL) throws {
        try operation("remove \(path.path)")
        files = files.filter { !$0.key.hasPrefix(path.path + "/") }
        directories = directories.filter { $0 != path.path && !$0.hasPrefix(path.path + "/") }
    }
}
