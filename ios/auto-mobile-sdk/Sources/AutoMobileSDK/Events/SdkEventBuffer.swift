import Foundation
import os

/// Protocol for event buffering to allow faking in tests.
protocol EventBuffering: AnyObject, Sendable {
    var isBufferEnabled: Bool { get set }
    func add(_ event: any SdkEvent)
    func start()
    func stop()
    func shutdown()
    func flush()
}

/// Thread-safe event buffer that flushes on capacity or timer.
final class SdkEventBuffer: EventBuffering, Sendable {
    private struct State: Sendable {
        var buffer: [any SdkEvent] = []
        var timer: (any TimerScheduling)?
        var isBufferEnabled = true
    }

    private let maxBufferSize: Int
    private let maxPendingEvents: Int
    private let flushIntervalMs: Int
    private let onFlush: @Sendable ([any SdkEvent]) throws -> Void
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let timerFactory: @Sendable () -> any TimerScheduling
    private let dropCounter: (any DropCounting)?
    private let processors: [any EventProcessing]

    init(
        maxBufferSize: Int = 50,
        flushIntervalMs: Int = 500,
        maxPendingEvents: Int = 500,
        processors: [any EventProcessing] = [],
        timerFactory: @escaping @Sendable () -> any TimerScheduling = { GCDTimer() },
        dropCounter: (any DropCounting)? = nil,
        onFlush: @escaping @Sendable ([any SdkEvent]) throws -> Void
    ) {
        self.maxBufferSize = maxBufferSize
        self.maxPendingEvents = max(1, maxPendingEvents)
        self.flushIntervalMs = flushIntervalMs
        self.processors = processors
        self.timerFactory = timerFactory
        self.dropCounter = dropCounter
        self.onFlush = onFlush
    }

    var isBufferEnabled: Bool {
        get {
            state.withLock { $0.isBufferEnabled }
        }
        set {
            state.withLock { $0.isBufferEnabled = newValue }
        }
    }

    func start() {
        state.withLock { state in
            guard state.timer == nil else { return }
            let t = timerFactory()
            state.timer = t
            t.schedule(intervalMs: flushIntervalMs) { [weak self] in
                self?.flush()
            }
        }
    }

    /// Stop the periodic flush timer without flushing remaining events.
    func stop() {
        state.withLock { state in
            state.timer?.cancel()
            state.timer = nil
        }
    }

    func add(_ event: any SdkEvent) {
        // Check disabled state first, before running processors
        guard isBufferEnabled else {
            dropCounter?.increment(.disabled)
            return
        }

        // Run processor chain outside lock
        var current: (any SdkEvent)? = event
        for processor in processors {
            guard let e = current else { break }
            current = processor.process(e)
        }
        guard let processed = current else {
            dropCounter?.increment(.filtered)
            return
        }

        let result = state.withLock { state -> (disabled: Bool, didOverflow: Bool, shouldFlush: Bool) in
            guard state.isBufferEnabled else { return (true, false, false) }
            var didOverflow = false
            if maxPendingEvents > 0, state.buffer.count >= maxPendingEvents {
                state.buffer.removeFirst()
                didOverflow = true
            }
            state.buffer.append(processed)
            return (false, didOverflow, state.buffer.count >= maxBufferSize)
        }
        if result.disabled {
            dropCounter?.increment(.disabled)
            return
        }
        if result.didOverflow {
            dropCounter?.increment(.bufferOverflow)
        }
        if result.shouldFlush {
            flush()
        }
    }

    func flush() {
        let events = state.withLock { state in
            guard !state.buffer.isEmpty else { return [any SdkEvent]() }
            let events = state.buffer
            state.buffer.removeAll(keepingCapacity: true)
            return events
        }
        guard !events.isEmpty else { return }
        do {
            try onFlush(events)
        } catch {
            dropCounter?.increment(.flushError, count: events.count)
        }
    }

    func shutdown() {
        let remaining = state.withLock { state in
            state.timer?.cancel()
            state.timer = nil
            let remaining = state.buffer
            state.buffer.removeAll()
            return remaining
        }
        if !remaining.isEmpty {
            do {
                try onFlush(remaining)
            } catch {
                dropCounter?.increment(.flushError, count: remaining.count)
            }
        }
    }
}

// MARK: - Timer Abstraction

/// Protocol for timer scheduling to allow faking in tests.
protocol TimerScheduling: AnyObject, Sendable {
    func schedule(intervalMs: Int, block: @escaping @Sendable () -> Void)
    func cancel()
}

/// GCD-based timer implementation.
final class GCDTimer: TimerScheduling, Sendable {
    private let source = OSAllocatedUnfairLock<DispatchSourceTimer?>(initialState: nil)
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.timer")

    init() {}

    func schedule(intervalMs: Int, block: @escaping @Sendable () -> Void) {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(
            deadline: .now() + .milliseconds(intervalMs),
            repeating: .milliseconds(intervalMs)
        )
        source.setEventHandler(handler: block)
        source.resume()
        self.source.withLock { $0 = source }
    }

    func cancel() {
        source.withLock { source in
            source?.cancel()
            source = nil
        }
    }

    deinit {
        source.withLock { _ = $0?.cancel() }
    }
}
