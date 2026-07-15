import Darwin
import Dispatch
import Foundation
import JarvisMacOSSpeechCore

#if arch(arm64)
  let helperArchitecture = "arm64"
#elseif arch(x86_64)
  let helperArchitecture = "x86_64"
#else
  let helperArchitecture = "unknown"
#endif

let emitter = EventEmitter()
let controller = VoiceController(emitter: emitter)

signal(SIGPIPE, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruptSource.setEventHandler {
  controller.shutdown(requestId: nil, reason: "signal")
}
interruptSource.resume()

let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminationSource.setEventHandler {
  controller.shutdown(requestId: nil, reason: "signal")
}
terminationSource.resume()

emitter.emit(
  type: "ready",
  payload: ReadyPayload(
    helperVersion: "1.0.0",
    processId: getpid(),
    architecture: helperArchitecture,
    capabilities: ["pushToTalk", "speechRecognition", "speechSynthesis"],
    maximumLineBytes: VoiceProtocolLimits.maximumLineBytes,
    maximumListeningDurationMs: VoiceProtocolLimits.maximumDurationMilliseconds,
    maximumTextBytes: VoiceProtocolLimits.maximumTextBytes
  )
)

DispatchQueue.global(qos: .userInitiated).async {
  var framer = NDJSONLineFramer()
  let input = FileHandle.standardInput

  func process(_ frame: NDJSONFrame) {
    switch frame {
    case .oversizedLine:
      emitter.emitError(
        code: "line_too_large",
        message: "Command exceeds the 64 KiB line limit.",
        recoverable: true
      )
    case .line(let line):
      do {
        let command = try VoiceCommandDecoder.decode(line: line)
        DispatchQueue.main.async {
          controller.handle(command)
        }
      } catch let error as VoiceProtocolError {
        emitter.emitError(
          code: error.code,
          message: error.message,
          recoverable: true
        )
      } catch {
        emitter.emitError(
          code: "invalid_command",
          message: "Command could not be decoded.",
          recoverable: true
        )
      }
    }
  }

  while true {
    // availableData returns as soon as pipe data arrives. read(upToCount:) can
    // wait for a larger buffer when stdin remains open (the normal Electron case).
    let chunk = input.availableData
    guard !chunk.isEmpty else { break }
    for frame in framer.append(chunk) {
      process(frame)
    }
  }

  for frame in framer.finish() {
    process(frame)
  }
  DispatchQueue.main.async {
    controller.shutdown(requestId: nil, reason: "stdin_closed")
  }
}

dispatchMain()
