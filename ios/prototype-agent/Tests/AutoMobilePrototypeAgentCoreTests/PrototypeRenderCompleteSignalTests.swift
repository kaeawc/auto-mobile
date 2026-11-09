@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private final class RenderSignalFiles: PrototypeEndpointFiles {
    enum Failure: Error { case write }
    var contents: [String: Data] = [:]
    var writes = 0
    var failWrite = false

    func writeAtomically(_ data: Data, to path: String, mode: UInt16) throws {
        XCTAssertEqual(mode, 0o600)
        if failWrite { throw Failure.write }
        contents[path] = data
        writes += 1
    }

    func remove(path: String) throws { contents[path] = nil }
}

private final class RenderSignalClock: PrototypeMonotonicClock {
    var monotonicMilliseconds = 12000
}

@MainActor
private final class RenderSignalFrames: PrototypeRenderFrameSource {
    var callback: (@MainActor () -> Void)?
    private(set) var starts = 0

    func start(_ frame: @escaping @MainActor () -> Void) {
        starts += 1
        callback = frame
    }

    func stop() { callback = nil }

    func advance(_ count: Int = 1) {
        for _ in 0 ..< count { callback?() }
    }
}

@MainActor
private final class RenderSignalFixture {
    let files = RenderSignalFiles()
    let frames = RenderSignalFrames()
    let clock = RenderSignalClock()
    let signal: PrototypeRenderCompleteSignal
    var animated: Bool? = false
    var errors = 0

    init() {
        signal = PrototypeRenderCompleteSignal(
            documents: URL(fileURLWithPath: "/injected/Documents"), frames: frames, clock: clock, files: files
        )
    }

    func rendered(specId: String = "first", revision: Int = 1) {
        signal.rendered(specId: specId, revision: revision, hasAnimations: { [self] in
            animated
        }, onError: { [self] _ in errors += 1 })
    }
}

@MainActor
final class PrototypeRenderCompleteSignalTests: XCTestCase {
    func testWritesOnlyAfterTenQuietFramesAndOnlyOnce() throws {
        let fixture = RenderSignalFixture()
        let signal = fixture.signal
        XCTAssertEqual(signal.path, "/injected/Documents/prototype/render-complete")
        try signal.beginShow(specId: "first", revision: 1)
        XCTAssertNil(fixture.files.contents[signal.path])
        fixture.frames.advance(20) // Appearance/layout have not yet advertised readiness.
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.rendered()
        let completedCallback = fixture.frames.callback
        fixture.rendered() // Repeated layout must not restart the count or frame source.
        XCTAssertEqual(fixture.frames.starts, 1)
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.contents[signal.path], Data("first\n".utf8))
        XCTAssertNil(fixture.frames.callback)
        fixture.rendered()
        fixture.frames.advance(20)
        completedCallback?()
        XCTAssertEqual(fixture.files.writes, 1)
        XCTAssertEqual(fixture.frames.starts, 1)
    }

    func testAnimationResetsConsecutiveQuietFrameCount() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.rendered()
        fixture.frames.advance(9)
        fixture.animated = true
        fixture.frames.advance(3)
        fixture.animated = false
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
    }

    func testPersistentAnimationWritesAtFiveSecondBound() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.animated = true
        fixture.rendered()
        fixture.frames.advance(400) // Frame count alone must not trigger the elapsed-time bound.
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.clock.monotonicMilliseconds += 4999
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.clock.monotonicMilliseconds += 1
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
        XCTAssertNil(fixture.frames.callback)
    }

    func testNewShowClearsMarkerAndRejectsSupersededSpecAndRevision() throws {
        let fixture = RenderSignalFixture()
        let signal = fixture.signal
        fixture.files.contents[signal.path] = Data("stale\n".utf8)
        try signal.beginShow(specId: "first", revision: 1)
        XCTAssertNil(fixture.files.contents[signal.path])
        fixture.rendered()
        fixture.frames.advance(10)
        try signal.beginShow(specId: "second", revision: 2)
        XCTAssertNil(fixture.files.contents[signal.path])
        fixture.rendered()
        fixture.rendered(specId: "second", revision: 1)
        XCTAssertNil(fixture.frames.callback)
        fixture.rendered(specId: "second", revision: 2)
        fixture.frames.advance(10)
        XCTAssertEqual(fixture.files.contents[signal.path], Data("second\n".utf8))
        try signal.beginShow(specId: "second", revision: 3)
        XCTAssertNil(fixture.files.contents[signal.path])
        fixture.rendered(specId: "second", revision: 2)
        XCTAssertNil(fixture.frames.callback)
        fixture.rendered(specId: "second", revision: 3)
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 2)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 3)
    }

    func testRevisionChangeResetsCountAndDeadlineAndIgnoresOldCallback() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.rendered()
        fixture.frames.advance(9)
        let oldCallback = fixture.frames.callback
        fixture.clock.monotonicMilliseconds += 4999
        try fixture.signal.beginShow(specId: "first", revision: 2)
        fixture.rendered(revision: 2)
        fixture.clock.monotonicMilliseconds += 1
        oldCallback?()
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.animated = true
        fixture.frames.advance()
        fixture.clock.monotonicMilliseconds += 4998
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.clock.monotonicMilliseconds += 1
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
    }

    func testBeginningSameShowAgainClearsWriteOnceState() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.rendered()
        fixture.frames.advance(10)
        try fixture.signal.beginShow(specId: "first", revision: 1)
        XCTAssertNil(fixture.files.contents[fixture.signal.path])
        fixture.rendered()
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 1)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 2)
    }

    func testWithdrawnReadinessCancelsEvenAfterDeadlineAndCanRestart() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.rendered()
        fixture.frames.advance(9)
        fixture.animated = nil // The viewer became hidden or its model revision changed.
        fixture.clock.monotonicMilliseconds += 5000
        fixture.frames.advance()
        XCTAssertNil(fixture.frames.callback)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.animated = false
        fixture.rendered()
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
    }

    func testExplicitCancellationRejectsQueuedFramesAndRestartsCount() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.rendered()
        fixture.frames.advance(9)
        let oldCallback = fixture.frames.callback
        fixture.signal.cancelPolling()
        oldCallback?()
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.rendered()
        fixture.frames.advance(9)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
    }

    func testFailedWriteIsReportedAndRetriedOnNextFrame() throws {
        let fixture = RenderSignalFixture()
        try fixture.signal.beginShow(specId: "first", revision: 1)
        fixture.files.failWrite = true
        fixture.rendered()
        fixture.frames.advance(10)
        XCTAssertEqual(fixture.errors, 1)
        XCTAssertEqual(fixture.files.writes, 0)
        fixture.files.failWrite = false
        fixture.frames.advance()
        XCTAssertEqual(fixture.files.writes, 1)
        XCTAssertNil(fixture.frames.callback)
    }
}
