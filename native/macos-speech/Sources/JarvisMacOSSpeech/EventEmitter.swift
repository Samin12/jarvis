import Foundation
import JarvisMacOSSpeechCore

struct EmptyPayload: Encodable {}

struct ReadyPayload: Encodable {
  let helperVersion: String
  let processId: Int32
  let architecture: String
  let capabilities: [String]
  let maximumLineBytes: Int
  let maximumListeningDurationMs: Int
  let maximumTextBytes: Int
}

struct StatusPayload: Encodable {
  let speechAuthorization: String
  let microphoneAuthorization: String
  let recognizerAvailable: Bool
  let supportsOnDeviceRecognition: Bool
  let locale: String
  let listening: Bool
  let speaking: Bool
}

struct PermissionPayload: Encodable {
  let speechAuthorization: String
  let microphoneAuthorization: String
}

struct ListeningStatePayload: Encodable {
  let state: String
  let sessionId: String
  let startRequestId: String
  let reason: String?
}

struct TranscriptPayload: Encodable {
  let sessionId: String
  let text: String
  let isFinal: Bool
}

struct SpeechStatePayload: Encodable {
  let state: String
  let sessionId: String
  let speakRequestId: String
  let reason: String?
}

struct ErrorPayload: Encodable {
  let code: String
  let message: String
  let recoverable: Bool
  let domain: String?
  let nativeCode: Int?
}

private struct EventEnvelope<Payload: Encodable>: Encodable {
  let type: String
  let protocolVersion: Int
  let requestId: String?
  let timestampMs: Int64
  let data: Payload
}

final class EventEmitter: @unchecked Sendable {
  private let encoder: JSONEncoder
  private let lock = NSLock()
  private let output: FileHandle

  init(output: FileHandle = .standardOutput) {
    self.output = output
    encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  }

  func emit<Payload: Encodable>(
    type: String,
    requestId: String? = nil,
    payload: Payload
  ) {
    let envelope = EventEnvelope(
      type: type,
      protocolVersion: VoiceProtocolLimits.version,
      requestId: requestId,
      timestampMs: Int64(Date().timeIntervalSince1970 * 1_000),
      data: payload
    )

    lock.lock()
    defer { lock.unlock() }
    guard var encoded = try? encoder.encode(envelope) else { return }
    encoded.append(0x0A)
    output.write(encoded)
  }

  func emitError(
    requestId: String? = nil,
    code: String,
    message: String,
    recoverable: Bool,
    domain: String? = nil,
    nativeCode: Int? = nil
  ) {
    emit(
      type: "error",
      requestId: requestId,
      payload: ErrorPayload(
        code: code,
        message: message,
        recoverable: recoverable,
        domain: domain,
        nativeCode: nativeCode
      )
    )
  }
}
