import Darwin
import Foundation

/// POSIX `write(2)` helpers for the helper's stdout and stderr pipes.
///
/// `FileHandle.write(_:)` raises an Objective-C `NSFileHandleOperationException`
/// when the descriptor is closed (EPIPE with SIGPIPE ignored, or EBADF). Swift
/// cannot catch it, so it terminates the helper: SIGABRT on the main thread, and
/// SIGTRAP when it is raised from a Dispatch queue such as the one-second frame
/// metrics timer. A closed stderr reader therefore killed a healthy capture
/// mid-stream (#7604, #7607). These helpers report the failure instead.
public enum DescriptorWrite {
    /// Writes every byte of `data` to `fileDescriptor`, retrying on EINTR and
    /// continuing after partial writes. Returns `false` on any other failure
    /// (EPIPE, EBADF, ...), leaving `errno` set by the failing `write(2)`.
    @discardableResult
    public static func writeAll(_ data: Data, toFileDescriptor fileDescriptor: Int32) -> Bool {
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return true }
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fileDescriptor, base.advanced(by: offset), bytes.count - offset)
                if written > 0 {
                    offset += written
                } else if written == -1 && errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        }
    }

    /// Best-effort diagnostic write (stderr by default). Diagnostics never decide
    /// the process's fate: when the reader is gone the text is dropped, and the
    /// stdout data channel's own closed-output handling still ends the capture.
    public static func writeDiagnostic(_ text: String, toFileDescriptor fileDescriptor: Int32 = STDERR_FILENO) {
        writeAll(Data(text.utf8), toFileDescriptor: fileDescriptor)
    }
}
