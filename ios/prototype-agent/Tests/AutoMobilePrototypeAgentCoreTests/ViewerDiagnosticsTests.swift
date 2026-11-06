@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class ViewerDiagnosticsTests: XCTestCase {
    func testExactFormattingAndEmptyDefaults() {
        let diagnostics = ViewerDiagnostics(appVersion: "1.2.3", osVersion: "26.1", capabilities: ["z", "a", "z"])
        XCTAssertEqual(diagnostics.format(), """
        ProtoViewer diagnostics
        platform: ios
        app-version: 1.2.3
        os-version: 26.1
        capabilities: a,z
        last-error: none
        watchdog-tripped: false
        """)
        XCTAssertTrue(
            ViewerDiagnostics(appVersion: "unknown", osVersion: "17.0", capabilities: [])
                .format().contains("capabilities: none\n")
        )
    }

    func testSpecLabelStorageAndValidatorDetailsCannotEnterCopiedText() throws {
        let sentinel = "PRIVATE_SENTINEL_DO_NOT_COPY"
        let files = PrototypeLibraryFakeFileSystem()
        let store = try PrototypeLibraryStore(
            root: URL(fileURLWithPath: "/app/library"), storageRoot: URL(fileURLWithPath: "/app/storage"),
            files: files, clock: PrototypeLibraryFakeClock(),
            libraryId: { "00000000-0000-0000-0000-000000000001" }
        )
        let spec = Data("""
        {"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"\(sentinel)"}}
        """.utf8)
        let entry = try store.add(
            PrototypeBundle(spec: spec, assets: [:], fonts: [:], requires: []), label: sentinel, source: .file
        )
        let storage = try store.storageURL(entry.libraryId).appendingPathComponent("state.json")
        try files.writeAtomic(storage, bytes: JSONEncoder().encode(["secret": sentinel]))
        XCTAssertEqual(try store.load(entry.libraryId).spec, spec)
        XCTAssertEqual(entry.label, sentinel)
        let savedState = try XCTUnwrap(String(data: files.read(storage, cap: 1024), encoding: .utf8))
        XCTAssertTrue(savedState.contains(sentinel))

        var diagnostics = ViewerDiagnostics(appVersion: "1", osVersion: "26", capabilities: ["prototype_text_v1"])
        diagnostics.record(ViewerFailure(rendererError: .invalidSpec(path: sentinel, message: sentinel)))
        let copied = diagnostics.format()
        XCTAssertTrue(copied.contains("last-error: validation\n"))
        XCTAssertFalse(copied.contains(sentinel))
        XCTAssertFalse(copied.contains(entry.libraryId))
        XCTAssertFalse(copied.contains("state.json"))
        XCTAssertEqual(ViewerFailure(rendererError: .unsupportedCapabilities([sentinel])), .validation)
        for failure in ViewerFailure.allCases {
            diagnostics.record(failure)
            XCTAssertTrue(diagnostics.format().contains("last-error: \(failure.rawValue)\n"))
            XCTAssertFalse(diagnostics.format().contains(sentinel))
        }
    }

    func testWatchdogExpirySetsStickyFlagAndCancelledTimerDoesNot() throws {
        let clock = DiagnosticsClock()
        let watchdog = PrototypeRenderWatchdog(clock: clock)
        var diagnostics = ViewerDiagnostics(appVersion: "1", osVersion: "26", capabilities: [])
        watchdog.start { diagnostics.record(.watchdog) }
        let cancelled = try XCTUnwrap(clock.fire)
        watchdog.cancel()
        cancelled()
        XCTAssertTrue(diagnostics.format().hasSuffix("last-error: none\nwatchdog-tripped: false"))
        watchdog.start { diagnostics.record(.watchdog) }
        try XCTUnwrap(clock.fire)()
        XCTAssertTrue(diagnostics.format().hasSuffix("last-error: watchdog\nwatchdog-tripped: true"))
        diagnostics.record(.render)
        XCTAssertTrue(diagnostics.format().hasSuffix("last-error: render\nwatchdog-tripped: true"))
    }
}

private final class DiagnosticsClock: PrototypeClock {
    var fire: (() -> Void)?
    func schedule(afterMilliseconds _: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        self.fire = fire
        return DiagnosticsTimer()
    }
}

private final class DiagnosticsTimer: PrototypeTimerHandle {
    func cancel() {}
}
