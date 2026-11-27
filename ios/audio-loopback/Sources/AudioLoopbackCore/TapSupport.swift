import Foundation

/// Which host processes belong to one iOS Simulator (#19046). Every process inside a booted device
/// descends from that device's `launchd_sim`, and each one is an ordinary client of the host's
/// `coreaudiod`, so its descendants are exactly the device's audio clients.
public enum ProcessTree {
    /// The processes below `root` (not `root` itself), given each process's parent.
    public static func descendants(of root: Int32, parents: [Int32: Int32]) -> Set<Int32> {
        var children: [Int32: [Int32]] = [:]
        for (pid, parent) in parents where pid != parent {
            children[parent, default: []].append(pid)
        }
        var found = Set<Int32>()
        var pending = children[root] ?? []
        while let pid = pending.popLast() {
            if found.insert(pid).inserted {
                pending.append(contentsOf: children[pid] ?? [])
            }
        }
        return found
    }
}

/// Mixes a tap's interleaved frames to mono.
public enum MonoMix {
    public static func interleaved(_ samples: UnsafeBufferPointer<Float>, channels: Int) -> [Float] {
        let channelCount = max(1, channels)
        let frames = samples.count / channelCount
        return (0 ..< frames).map { frame in
            var sum: Float = 0
            for channel in 0 ..< channelCount {
                sum += samples[frame * channelCount + channel]
            }
            return sum / Float(channelCount)
        }
    }
}

/// Resamples mono samples to the requested rate. Linear
/// interpolation keeps its position across buffers, so a stream split into any buffer sizes gives the
/// same output.
public struct MonoResampler {
    public let inputRate: Double
    public let outputRate: Double
    /// Position of the next output sample, in input frames, where `previous` sits at 0 and sample k of
    /// the current buffer at k + 1.
    private var position = 1.0
    private var previous: Float = 0

    public init(inputRate: Double, outputRate: Double) {
        self.inputRate = inputRate
        self.outputRate = outputRate
    }

    public mutating func resample(_ input: [Float]) -> [Float] {
        guard !input.isEmpty else {
            return []
        }
        if inputRate == outputRate {
            return input
        }
        let step = inputRate / outputRate
        var output: [Float] = []
        output.reserveCapacity(Int(Double(input.count) / step) + 1)
        while position <= Double(input.count) {
            let index = Int(position)
            let fraction = Float(position - Double(index))
            let left = index == 0 ? previous : input[index - 1]
            let right = index < input.count ? input[index] : left
            output.append(left + (right - left) * fraction)
            position += step
        }
        position -= Double(input.count)
        previous = input[input.count - 1]
        return output
    }
}

extension Pcm16Mono {
    /// 16-bit signed little-endian samples, clamped to full scale.
    public static func encode(_ samples: [Float]) -> Data {
        var data = Data(count: samples.count * bytesPerFrame)
        data.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for (index, sample) in samples.enumerated() {
                let clamped = max(-1, min(1, sample))
                out[index] = Int16(clamped * Float(Int16.max)).littleEndian
            }
        }
        return data
    }
}

/// How much silence a capture owes to keep its length equal to the wall clock.
public enum SilenceFill {
    /// Frames still owed at `elapsedMs`, holding back the newest `lagMs` (audio may still be in flight);
    /// a stop passes 0 so the withheld quiet tail is flushed too.
    public static func dueFrames(elapsedMs: Int, lagMs: Int, sampleRate: Int, framesWritten: Int) -> Int {
        max(0, (elapsedMs - lagMs) * sampleRate / 1000 - framesWritten)
    }
}

/// The running process tap and the audio clients it covers (#19115). A running tap's process list
/// cannot change, so a new client set means a new tap. The new tap is built before the old one is torn
/// down, so the clients that keep playing never drop audio. A failed build keeps the old tap and leaves
/// a retry pending instead of ending the capture: a client can exit between enumeration and tap
/// creation (terminateApp mid-recording). While the same client set keeps failing, the retry backs off
/// (one tick, doubling up to `maxRetryTicks`) and the `warnAfterFailures`th failure in a row asks for
/// one warning (#19432); a new client set or a successful build resets both.
public struct TapSwap<Client: Hashable, Tap> {
    public enum Outcome {
        case unchanged
        case rebuilt
        /// `warn` is true only for the failure that reaches `warnAfterFailures` in a row.
        case failed(any Error, warn: Bool)
        /// The same client set failed and its backoff has not elapsed, so nothing was built.
        case backingOff
    }

    public private(set) var tap: Tap?
    public private(set) var clients: [Client: Int32] = [:]
    /// The longest wait between retries of one failing client set, in caller ticks.
    public let maxRetryTicks: Int
    public let warnAfterFailures: Int
    /// The client set whose build last failed, while a retry is pending.
    private var failedClients: [Client: Int32]?
    /// Builds of `failedClients` that failed in a row.
    public private(set) var consecutiveFailures = 0
    /// Ticks left before the pending retry is due.
    public private(set) var ticksUntilRetry = 0

    /// The last build failed; the caller retries once `retryDue()` says so.
    public var retryPending: Bool {
        failedClients != nil
    }

    public init(maxRetryTicks: Int = 50, warnAfterFailures: Int = 5) {
        self.maxRetryTicks = max(1, maxRetryTicks)
        self.warnAfterFailures = max(1, warnAfterFailures)
    }

    /// Advances the backoff by one tick; true when the pending retry should run now.
    public mutating func retryDue() -> Bool {
        guard retryPending else {
            return false
        }
        ticksUntilRetry = max(0, ticksUntilRetry - 1)
        return ticksUntilRetry == 0
    }

    /// Moves to `clients`, building their tap with `build` (not called for no clients) and only then
    /// tearing down the previous tap with `destroy`.
    public mutating func update(
        to clients: [Client: Int32],
        build: ([Client: Int32]) throws -> Tap,
        destroy: (Tap) -> Void
    ) -> Outcome {
        guard clients != self.clients else {
            clearFailures()
            return .unchanged
        }
        if clients == failedClients, ticksUntilRetry > 0 {
            return .backingOff
        }
        let next: Tap?
        do {
            next = clients.isEmpty ? nil : try build(clients)
        } catch {
            consecutiveFailures = clients == failedClients ? consecutiveFailures + 1 : 1
            failedClients = clients
            let shift = min(consecutiveFailures - 1, Int.bitWidth - 2)
            ticksUntilRetry = min(maxRetryTicks, 1 << shift)
            return .failed(error, warn: consecutiveFailures == warnAfterFailures)
        }
        let previous = tap
        tap = next
        self.clients = clients
        clearFailures()
        if let previous {
            destroy(previous)
        }
        return .rebuilt
    }

    /// Tears down the running tap, if any.
    public mutating func tearDown(destroy: (Tap) -> Void) {
        if let previous = tap {
            destroy(previous)
        }
        tap = nil
        clients = [:]
        clearFailures()
    }

    private mutating func clearFailures() {
        failedClients = nil
        consecutiveFailures = 0
        ticksUntilRetry = 0
    }
}
