@testable import AutoMobilePrototypeAgentCore
import Foundation
import os
import XCTest

final class PrototypeLibraryImportServiceTests: XCTestCase {
    @MainActor
    func testReadAndCommitRunOffMainActorAndCleanupFollowsSuccess() async throws {
        let events = OSAllocatedUnfairLock(initialState: [String]())
        let service = PrototypeLibraryImportService(
            read: { _ in
                XCTAssertFalse(Thread.isMainThread)
                events.withLock { $0.append("read") }
                return Data([1])
            },
            commit: { bytes, source in
                XCTAssertFalse(Thread.isMainThread)
                XCTAssertEqual(bytes, Data([1]))
                XCTAssertEqual(source, .share)
                events.withLock { $0.append("commit") }
            },
            cleanup: { _ in events.withLock { $0.append("cleanup") } },
            warning: { _ in XCTFail("Unexpected cleanup warning") }
        )
        try await service.importFile(URL(fileURLWithPath: "/Inbox/spec.json"), source: .share)
        XCTAssertEqual(events.withLock { $0 }, ["read", "commit", "cleanup"])
    }

    @MainActor
    func testCleanupFailureAfterCommitIsOnlyANonfatalWarning() async throws {
        let warnings = OSAllocatedUnfairLock(initialState: [String]())
        let service = PrototypeLibraryImportService(
            read: { _ in Data([1]) },
            commit: { _, _ in },
            cleanup: { _ in throw POSIXError(.EACCES) },
            warning: { message in warnings.withLock { $0.append(message) } }
        )
        try await service.importFile(URL(fileURLWithPath: "/Inbox/spec.json"), source: .file)
        XCTAssertEqual(warnings.withLock { $0.count }, 1)
    }

    @MainActor
    func testReadAndValidationFailuresStillCleanupAndPreserveOriginalError() async {
        for failRead in [true, false] {
            let events = OSAllocatedUnfairLock(initialState: [String]())
            let service = PrototypeLibraryImportService(
                read: { _ in
                    if failRead { throw POSIXError(.EIO) }
                    return Data([1])
                },
                commit: { _, _ in throw POSIXError(.EINVAL) },
                cleanup: { _ in
                    events.withLock { $0.append("cleanup") }
                    throw POSIXError(.EACCES)
                },
                warning: { message in events.withLock { $0.append(message) } }
            )
            do {
                try await service.importFile(URL(fileURLWithPath: "/Inbox/spec.json"), source: .file)
                XCTFail("Expected import failure")
            } catch {
                XCTAssertEqual((error as? POSIXError)?.code, failRead ? .EIO : .EINVAL)
            }
            let recorded = events.withLock { $0 }
            XCTAssertEqual(recorded.first, "cleanup")
            XCTAssertEqual(recorded.count, 2)
            XCTAssertTrue(recorded.last?.contains("Inbox cleanup failed") == true)
        }
    }

    @MainActor
    func testCancellationBeforeReadOrBeforeCommitStillCleansInboxCopy() async {
        for cancelBeforeRead in [true, false] {
            let events = OSAllocatedUnfairLock(initialState: [String]())
            let checks = OSAllocatedUnfairLock(initialState: 0)
            let service = PrototypeLibraryImportService(
                read: { _ in
                    events.withLock { $0.append("read") }
                    return Data([1])
                },
                commit: { _, _ in XCTFail("Cancelled imports must not commit") },
                cleanup: { _ in events.withLock { $0.append("cleanup") } },
                warning: { _ in XCTFail("Unexpected cleanup warning") },
                checkCancellation: {
                    let count = checks.withLock { $0 += 1; return $0 }
                    if cancelBeforeRead || count == 2 { throw CancellationError() }
                }
            )
            do {
                try await service.importFile(URL(fileURLWithPath: "/Inbox/spec.json"), source: .file)
                XCTFail("Expected cancellation")
            } catch {
                XCTAssertTrue(error is CancellationError)
            }
            XCTAssertEqual(events.withLock { $0 }, cancelBeforeRead ? ["cleanup"] : ["read", "cleanup"])
        }
    }
}
