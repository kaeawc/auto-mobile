import CryptoKit
import Foundation

extension Data {
    /// SHA-1 digest of the bytes. Used by the RFC 6455 handshake to compute the
    /// `Sec-WebSocket-Accept` value; ported verbatim from the reference target.
    func sha1() -> Data {
        Data(Insecure.SHA1.hash(data: self))
    }
}
