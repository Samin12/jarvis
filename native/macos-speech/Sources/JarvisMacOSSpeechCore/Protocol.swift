import CoreFoundation
import Foundation

public enum VoiceProtocolLimits {
  public static let version = 1
  public static let maximumLineBytes = 64 * 1024
  public static let maximumIdentifierBytes = 128
  public static let maximumLocaleBytes = 64
  public static let maximumVoiceIdentifierBytes = 256
  public static let maximumTextBytes = 20_000
  public static let minimumDurationMilliseconds = 1_000
  public static let defaultDurationMilliseconds = 30_000
  public static let maximumDurationMilliseconds = 60_000
}

public struct StartListeningOptions: Equatable, Sendable {
  public let locale: String
  public let requiresOnDeviceRecognition: Bool
  public let maximumDurationMilliseconds: Int

  public init(
    locale: String,
    requiresOnDeviceRecognition: Bool,
    maximumDurationMilliseconds: Int
  ) {
    self.locale = locale
    self.requiresOnDeviceRecognition = requiresOnDeviceRecognition
    self.maximumDurationMilliseconds = maximumDurationMilliseconds
  }
}

public struct SpeakOptions: Equatable, Sendable {
  public let text: String
  public let voiceIdentifier: String?
  /// A normalized 0...1 value mapped to AVSpeechUtterance's platform range.
  public let rate: Double?
  public let pitch: Double
  public let volume: Double

  public init(
    text: String,
    voiceIdentifier: String?,
    rate: Double?,
    pitch: Double,
    volume: Double
  ) {
    self.text = text
    self.voiceIdentifier = voiceIdentifier
    self.rate = rate
    self.pitch = pitch
    self.volume = volume
  }
}

public enum VoiceCommand: Equatable, Sendable {
  case status(id: String)
  case requestPermission(id: String)
  case start(id: String, options: StartListeningOptions)
  case stop(id: String)
  case cancel(id: String)
  case speak(id: String, options: SpeakOptions)
  case stopSpeaking(id: String)
  case shutdown(id: String)

  public var id: String {
    switch self {
    case .status(let value): return value
    case .requestPermission(let value): return value
    case .start(let value, _): return value
    case .stop(let value): return value
    case .cancel(let value): return value
    case .speak(let value, _): return value
    case .stopSpeaking(let value): return value
    case .shutdown(let value): return value
    }
  }
}

public struct VoiceProtocolError: Error, Equatable, Sendable {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }
}

public enum NDJSONFrame: Equatable, Sendable {
  case line(Data)
  case oversizedLine
}

/// Incremental line framer that never buffers more than the protocol line limit.
public struct NDJSONLineFramer: Sendable {
  private var buffer = Data()
  private var discardingOversizedLine = false
  private let maximumLineBytes: Int

  public init(maximumLineBytes: Int = VoiceProtocolLimits.maximumLineBytes) {
    self.maximumLineBytes = maximumLineBytes
  }

  public mutating func append(_ chunk: Data) -> [NDJSONFrame] {
    var frames: [NDJSONFrame] = []

    for byte in chunk {
      if discardingOversizedLine {
        if byte == 0x0A {
          discardingOversizedLine = false
          frames.append(.oversizedLine)
        }
        continue
      }

      if byte == 0x0A {
        var line = buffer
        buffer.removeAll(keepingCapacity: true)
        if line.last == 0x0D {
          line.removeLast()
        }
        if !line.isEmpty {
          frames.append(.line(line))
        }
        continue
      }

      if buffer.count >= maximumLineBytes {
        buffer.removeAll(keepingCapacity: false)
        discardingOversizedLine = true
      } else {
        buffer.append(byte)
      }
    }

    return frames
  }

  public mutating func finish() -> [NDJSONFrame] {
    if discardingOversizedLine {
      discardingOversizedLine = false
      buffer.removeAll(keepingCapacity: false)
      return [.oversizedLine]
    }
    guard !buffer.isEmpty else { return [] }
    var line = buffer
    buffer.removeAll(keepingCapacity: false)
    if line.last == 0x0D {
      line.removeLast()
    }
    return line.isEmpty ? [] : [.line(line)]
  }
}

public enum VoiceCommandDecoder {
  public static func decode(line: Data) throws -> VoiceCommand {
    guard line.count <= VoiceProtocolLimits.maximumLineBytes else {
      throw VoiceProtocolError(
        code: "line_too_large", message: "Command exceeds the 64 KiB line limit.")
    }

    let object: Any
    do {
      object = try JSONSerialization.jsonObject(with: line)
    } catch {
      throw VoiceProtocolError(code: "invalid_json", message: "Command is not valid JSON.")
    }

    guard let fields = object as? [String: Any] else {
      throw VoiceProtocolError(code: "invalid_command", message: "Command must be a JSON object.")
    }
    let type = try requiredString("type", in: fields, maximumBytes: 32)
    let id = try requiredString(
      "id",
      in: fields,
      maximumBytes: VoiceProtocolLimits.maximumIdentifierBytes
    )

    switch type {
    case "status":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .status(id: id)
    case "permission":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .requestPermission(id: id)
    case "start":
      try rejectUnknownFields(
        fields,
        allowed: ["id", "type", "locale", "requireOnDevice", "maxDurationMs"]
      )
      let locale =
        try optionalString(
          "locale",
          in: fields,
          maximumBytes: VoiceProtocolLimits.maximumLocaleBytes
        ) ?? Locale.current.identifier
      let requireOnDevice = try optionalBool("requireOnDevice", in: fields) ?? false
      let duration =
        try optionalInteger("maxDurationMs", in: fields)
        ?? VoiceProtocolLimits.defaultDurationMilliseconds
      let allowedDuration =
        VoiceProtocolLimits
        .minimumDurationMilliseconds...VoiceProtocolLimits.maximumDurationMilliseconds
      guard allowedDuration.contains(duration) else {
        throw VoiceProtocolError(
          code: "invalid_duration",
          message: "maxDurationMs must be between 1000 and 60000."
        )
      }
      return .start(
        id: id,
        options: StartListeningOptions(
          locale: locale,
          requiresOnDeviceRecognition: requireOnDevice,
          maximumDurationMilliseconds: duration
        )
      )
    case "stop":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .stop(id: id)
    case "cancel":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .cancel(id: id)
    case "speak":
      try rejectUnknownFields(
        fields,
        allowed: ["id", "type", "text", "voiceIdentifier", "rate", "pitch", "volume"]
      )
      let text = try requiredString(
        "text",
        in: fields,
        maximumBytes: VoiceProtocolLimits.maximumTextBytes
      )
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw VoiceProtocolError(code: "empty_text", message: "text must not be empty.")
      }
      let voiceIdentifier = try optionalString(
        "voiceIdentifier",
        in: fields,
        maximumBytes: VoiceProtocolLimits.maximumVoiceIdentifierBytes
      )
      let rate = try optionalDouble("rate", in: fields)
      if let rate, !(0...1).contains(rate) {
        throw VoiceProtocolError(code: "invalid_rate", message: "rate must be between 0 and 1.")
      }
      let pitch = try optionalDouble("pitch", in: fields) ?? 1
      guard (0.5...2).contains(pitch) else {
        throw VoiceProtocolError(code: "invalid_pitch", message: "pitch must be between 0.5 and 2.")
      }
      let volume = try optionalDouble("volume", in: fields) ?? 1
      guard (0...1).contains(volume) else {
        throw VoiceProtocolError(code: "invalid_volume", message: "volume must be between 0 and 1.")
      }
      return .speak(
        id: id,
        options: SpeakOptions(
          text: text,
          voiceIdentifier: voiceIdentifier,
          rate: rate,
          pitch: pitch,
          volume: volume
        )
      )
    case "stopSpeaking":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .stopSpeaking(id: id)
    case "shutdown":
      try rejectUnknownFields(fields, allowed: ["id", "type"])
      return .shutdown(id: id)
    default:
      throw VoiceProtocolError(
        code: "unknown_command", message: "Unsupported command type: \(type).")
    }
  }

  private static func rejectUnknownFields(_ fields: [String: Any], allowed: Set<String>) throws {
    let unknown = Set(fields.keys).subtracting(allowed)
    guard unknown.isEmpty else {
      throw VoiceProtocolError(
        code: "unknown_field",
        message: "Unsupported command field: \(unknown.sorted().joined(separator: ", "))."
      )
    }
  }

  private static func requiredString(
    _ key: String,
    in fields: [String: Any],
    maximumBytes: Int
  ) throws -> String {
    guard let value = fields[key] as? String else {
      throw VoiceProtocolError(code: "invalid_\(key)", message: "\(key) must be a string.")
    }
    guard !value.isEmpty, value.lengthOfBytes(using: .utf8) <= maximumBytes else {
      throw VoiceProtocolError(
        code: "invalid_\(key)",
        message: "\(key) is empty or exceeds \(maximumBytes) UTF-8 bytes."
      )
    }
    return value
  }

  private static func optionalString(
    _ key: String,
    in fields: [String: Any],
    maximumBytes: Int
  ) throws -> String? {
    guard fields[key] != nil else { return nil }
    return try requiredString(key, in: fields, maximumBytes: maximumBytes)
  }

  private static func optionalBool(_ key: String, in fields: [String: Any]) throws -> Bool? {
    guard let value = fields[key] else { return nil }
    guard let number = value as? NSNumber,
      CFGetTypeID(number) == CFBooleanGetTypeID()
    else {
      throw VoiceProtocolError(code: "invalid_\(key)", message: "\(key) must be a boolean.")
    }
    return number.boolValue
  }

  private static func optionalInteger(_ key: String, in fields: [String: Any]) throws -> Int? {
    guard let value = fields[key] else { return nil }
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite,
      number.doubleValue.rounded() == number.doubleValue
    else {
      throw VoiceProtocolError(code: "invalid_\(key)", message: "\(key) must be an integer.")
    }
    return number.intValue
  }

  private static func optionalDouble(_ key: String, in fields: [String: Any]) throws -> Double? {
    guard let value = fields[key] else { return nil }
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite
    else {
      throw VoiceProtocolError(code: "invalid_\(key)", message: "\(key) must be a finite number.")
    }
    return number.doubleValue
  }
}
