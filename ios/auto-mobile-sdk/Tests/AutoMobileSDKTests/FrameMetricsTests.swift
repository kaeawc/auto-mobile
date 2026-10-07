@testable import AutoMobileSDK
import Foundation
import XCTest

final class FrameMetricsTests: XCTestCase {
    @MainActor
    func testWindowAggregationAndNextWindow() throws {
        let source = FakeFrameTickSource()
        let clock = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 1000))
        let buffer = FakeEventBuffer()
        let collector = FrameMetricsCollector(source: source, dateProvider: clock, buffer: buffer)
        collector.setEnabled(true)
        source.tick(at: 0)
        source.tick(at: 0.25)
        source.tick(at: 0.5)
        clock.advance(by: 1)
        source.tick(at: 1)
        let first = try XCTUnwrap(buffer.events.first as? SdkFrameMetricsEvent)
        XCTAssertEqual(first.timestamp, 1_001_000)
        XCTAssertEqual(first.fps, 3)
        XCTAssertEqual(first.frameTimeMs, 1000.0 / 3)
        XCTAssertEqual(first.jankFrames, 1)
        for timestamp in [1.25, 1.5, 1.75, 2.0] { source.tick(at: timestamp) }
        let second = try XCTUnwrap(buffer.events.last as? SdkFrameMetricsEvent)
        XCTAssertEqual(buffer.events.count, 2)
        XCTAssertEqual(second.fps, 4)
        XCTAssertEqual(second.frameTimeMs, 250)
        XCTAssertEqual(second.jankFrames, 0)
        collector.setEnabled(false)
    }

    @MainActor
    func testEmptyWindowEmitsNothing() {
        let source = FakeFrameTickSource()
        let clock = FakeDateProvider()
        let buffer = FakeEventBuffer()
        let collector = FrameMetricsCollector(source: source, dateProvider: clock, buffer: buffer)
        collector.setEnabled(true)
        clock.advance(by: 10)
        // A first tick is only a baseline, not a completed frame.
        source.tick(at: 10)
        source.tick(at: 10)
        XCTAssertTrue(buffer.events.isEmpty)
        collector.setEnabled(false)
    }

    @MainActor
    func testDisabledEmitsNothingAndRestartDiscardsPartialWindow() throws {
        let source = FakeFrameTickSource()
        let buffer = FakeEventBuffer()
        let collector = FrameMetricsCollector(source: source, dateProvider: FakeDateProvider(), buffer: buffer)
        source.tick(at: 0)
        collector.setEnabled(true)
        source.tick(at: 0)
        source.tick(at: 0.25)
        collector.setEnabled(false)
        source.tick(at: 1)
        XCTAssertTrue(buffer.events.isEmpty)
        collector.setEnabled(true)
        source.tick(at: 10)
        for timestamp in [10.25, 10.5, 10.75, 11.0] { source.tick(at: timestamp) }
        let event = try XCTUnwrap(buffer.events.first as? SdkFrameMetricsEvent)
        XCTAssertEqual(event.fps, 4)
        XCTAssertEqual(event.jankFrames, 0)
        XCTAssertEqual(source.starts, 2)
        XCTAssertEqual(source.stops, 1)
        collector.setEnabled(false)
    }

    @MainActor
    func testJankUsesEachTicksNominalIntervalAndStrictBoundary() throws {
        let source = FakeFrameTickSource()
        let buffer = FakeEventBuffer()
        let collector = FrameMetricsCollector(source: source, dateProvider: FakeDateProvider(), buffer: buffer)
        collector.setEnabled(true)
        source.tick(at: 0)
        source.tick(at: 0.375, nominalInterval: 0.25) // exactly 1.5x: not jank
        source.tick(at: 1, nominalInterval: 0.5) // changed refresh interval: not jank
        let event = try XCTUnwrap(buffer.events.first as? SdkFrameMetricsEvent)
        XCTAssertEqual(event.jankFrames, 0)
        collector.setEnabled(false)
    }

    func testEventEncodingContract() throws {
        let event = SdkFrameMetricsEvent(timestamp: 1_700_000_000_004, fps: 55, frameTimeMs: 18, jankFrames: 2)
        let envelope = try SdkEventEnvelope(event)
        XCTAssertEqual(envelope.eventType.rawValue, "frame_metrics_event")
        let decoded = try JSONDecoder().decode(SdkFrameMetricsEvent.self, from: envelope.payload)
        XCTAssertEqual(decoded.timestamp, event.timestamp)
        XCTAssertEqual(decoded.fps, 55)
        XCTAssertEqual(decoded.frameTimeMs, 18)
        XCTAssertEqual(decoded.jankFrames, 2)
        XCTAssertEqual(decoded.eventType, .frameMetrics)
    }
}
