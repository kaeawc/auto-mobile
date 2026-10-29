import AudioLoopbackCore
import Foundation

enum LoopbackMain {
    static let usage = "Usage: audio-loopback-helper play [--sample-rate N] | "
        + "capture --duration-ms N [--sample-rate N]. PCM is 16-bit little-endian mono."

    /// Runs one command and never returns: the process exits when the command ends.
    static func run(_ arguments: [String]) -> Never {
        let command: LoopbackCommand
        do {
            command = try LoopbackCommand.parse(arguments)
        } catch {
            fail(LoopbackError(.usage, "\(error). \(usage)"))
        }
        let exitProcess: @Sendable (Int32) -> Void = { code in
            exit(code)
        }
        do {
            switch command {
            case let .play(sampleRate):
                let player = LoopbackPlayer(sampleRate: sampleRate, finished: exitProcess)
                try player.start(on: CoreAudioDevices.injectionTarget())
                // dispatchMain never returns, so `player` lives as long as the process.
                withExtendedLifetime(player) {
                    dispatchMain()
                }
            case let .capture(sampleRate, durationMs):
                let recorder = LoopbackRecorder(sampleRate: sampleRate, durationMs: durationMs, finished: exitProcess)
                try recorder.start(on: CoreAudioDevices.captureSource())
                withExtendedLifetime(recorder) {
                    dispatchMain()
                }
            }
        } catch let error as LoopbackError {
            fail(error)
        } catch {
            fail(LoopbackError(.audioFailed, "\(error)"))
        }
    }

    static func report(_ line: String) {
        try? FileHandle.standardError.write(contentsOf: Data((line + "\n").utf8))
    }

    static func fail(_ error: LoopbackError) -> Never {
        report(LoopbackMarker.error(error.failure, error.message))
        exit(2)
    }
}
