import Benchmark
import Foundation
import ScreenCaptureCore

// Per-frame byte-transform benchmarks for the ScreenCaptureCore hot path (the pure,
// device-free layer where the encoded path's copies live). These quantify the
// allocation/CPU cost the Swift-6 + performance pass targets: the avcC -> Annex-B
// access-unit assembly, the frame header build, and the audio PCM conversion.
//
// `.mallocCountTotal` is the headline metric — it is the count of heap allocations
// per iteration, which directly demonstrates the copy/alloc reduction (e.g. a keyframe
// access unit going from three heap buffers to one).

// A length-prefixed (avcC) sample: each NAL is a 4-byte big-endian length + payload.
// Payload content is irrelevant to the copy path, so a deterministic fill is used.
private func avccSample(nalSizes: [Int]) -> Data {
    var data = Data()
    for size in nalSizes {
        var length = UInt32(size).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(Data(repeating: 0xAB, count: size))
    }
    return data
}

// Representative compressed frames. A delta frame is a few NALs (~28 KB total); a
// keyframe is a single larger slice (~60 KB) that also carries SPS/PPS.
private let deltaSample = avccSample(nalSizes: [15_000, 8_000, 5_000])
private let keyframeSample = avccSample(nalSizes: [60_000])
private let parameterSets: [Data] = [
    Data(repeating: 0x67, count: 25),  // SPS
    Data(repeating: 0x68, count: 6),   // PPS
]
private let float32Audio = Data(repeating: 0x00, count: 320 * MemoryLayout<Float>.size)

// A raw buffer standing in for a VideoToolbox CMBlockBuffer's data pointer, used to
// compare the encoder's copy-out-then-assemble flow with the zero-extra-copy
// `Data(bytesNoCopy:)` flow that this pass adopts.
// `nonisolated(unsafe)`: a process-lifetime, write-once benchmark fixture read only
// from the benchmark closures; the raw buffer is not itself Sendable.
nonisolated(unsafe) private let blockBufferBytes: UnsafeMutableRawBufferPointer = {
    let buffer = UnsafeMutableRawBufferPointer.allocate(
        byteCount: deltaSample.count, alignment: 16
    )
    deltaSample.copyBytes(to: buffer)
    return buffer
}()

// A 1080p BGRA frame (1920x1080x4 ≈ 8.3 MB) standing in for the RAW path's per-frame
// payload — the largest per-frame slab in the system and where the copy cost is real
// (hundreds of µs, unlike the compressed path). The device capture (CVPixelBuffer lock /
// ScreenCaptureKit delivery) is not headless-testable, but the copy itself takes a raw
// pointer, so the pooled-vs-unpooled allocation cost around the same memcpy is.
private let rawFrameByteCount = 1920 * 1080 * 4
nonisolated(unsafe) private let rawFrame: UnsafeMutableRawBufferPointer = {
    let buffer = UnsafeMutableRawBufferPointer.allocate(byteCount: rawFrameByteCount, alignment: 16)
    buffer.initializeMemory(as: UInt8.self, repeating: 0xCD)
    return buffer
}()
nonisolated(unsafe) private let rawFramePool = FrameBufferPool()

let benchmarks: @Sendable () -> Void = {
    Benchmark.defaultConfiguration = .init(
        metrics: [.mallocCountTotal, .cpuTotal, .wallClock, .throughput],
        maxDuration: .seconds(2),
        maxIterations: 100_000
    )

    Benchmark("AnnexB assembleAccessUnit — delta (2 copies today)") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(
                try AnnexBConverter.assembleAccessUnit(
                    fromAvcc: deltaSample, nalUnitHeaderLength: 4,
                    parameterSets: [], isKeyframe: false
                )
            )
        }
    }

    Benchmark("AnnexB assembleAccessUnit — keyframe + SPS/PPS (3 copies today)") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(
                try AnnexBConverter.assembleAccessUnit(
                    fromAvcc: keyframeSample, nalUnitHeaderLength: 4,
                    parameterSets: parameterSets, isKeyframe: true
                )
            )
        }
    }

    // Isolates copy #1 (the encoder's copy-out of the CMBlockBuffer). The real encoder
    // path is device-only; these two siblings model its before/after in one run.
    Benchmark("encoder copy-out — Data(bytes:) + assemble (copy #1 present)") { benchmark in
        for _ in benchmark.scaledIterations {
            let copied = Data(bytes: blockBufferBytes.baseAddress!, count: blockBufferBytes.count)
            blackHole(
                try AnnexBConverter.assembleAccessUnit(
                    fromAvcc: copied, nalUnitHeaderLength: 4,
                    parameterSets: [], isKeyframe: false
                )
            )
        }
    }

    Benchmark("encoder copy-out — Data(bytesNoCopy:) + assemble (copy #1 elided)") { benchmark in
        for _ in benchmark.scaledIterations {
            let wrapped = Data(
                bytesNoCopy: blockBufferBytes.baseAddress!,
                count: blockBufferBytes.count, deallocator: .none
            )
            blackHole(
                try AnnexBConverter.assembleAccessUnit(
                    fromAvcc: wrapped, nalUnitHeaderLength: 4,
                    parameterSets: [], isKeyframe: false
                )
            )
        }
    }

    Benchmark("FrameProtocol.encodeEncodedVideoHeader") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(
                FrameProtocol.encodeEncodedVideoHeader(
                    payloadLength: 28_000, isKeyframe: false, presentationTimestampMs: 1234
                )
            )
        }
    }

    Benchmark("AudioPcm16Encoder.encodeFloat32LE") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(AudioPcm16Encoder.encodeFloat32LE(float32Audio))
        }
    }

    // Raw path: same ~8.3 MB memcpy either way — the delta is malloc + first-touch page
    // faulting of a fresh slab (unpooled) vs recycling one (pooled). CPU/wall is the
    // story here, not allocation count.
    Benchmark("raw frame copy — 1080p BGRA via FrameBufferPool (pooled)") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(rawFramePool.makeData(copyingFrom: rawFrame.baseAddress!, count: rawFrame.count))
        }
    }

    Benchmark("raw frame copy — 1080p BGRA via Data(bytes:) (unpooled)") { benchmark in
        for _ in benchmark.scaledIterations {
            blackHole(Data(bytes: rawFrame.baseAddress!, count: rawFrame.count))
        }
    }
}
