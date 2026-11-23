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
