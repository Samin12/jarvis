import Foundation
import Testing

@testable import JarvisMacOSSpeechCore

@Test func decodesBoundedStartCommand() throws {
  let command = try VoiceCommandDecoder.decode(
    line: Data(
      #"{"id":"req-1","type":"start","locale":"en-US","requireOnDevice":true,"maxDurationMs":15000}"#
        .utf8)
  )

  #expect(
    command
      == .start(
        id: "req-1",
        options: StartListeningOptions(
          locale: "en-US",
          requiresOnDeviceRecognition: true,
          maximumDurationMilliseconds: 15_000
        )
      )
  )
}

@Test func rejectsUnknownFields() throws {
  #expect(throws: VoiceProtocolError.self) {
    try VoiceCommandDecoder.decode(
      line: Data(#"{"id":"req-1","type":"status","shell":"open -a Calculator"}"#.utf8)
    )
  }
}

@Test func rejectsInvalidSpeechBounds() throws {
  do {
    _ = try VoiceCommandDecoder.decode(
      line: Data(#"{"id":"req-1","type":"speak","text":"hello","volume":2}"#.utf8)
    )
    Issue.record("Expected invalid_volume")
  } catch let error as VoiceProtocolError {
    #expect(error.code == "invalid_volume")
  }
}

@Test func framerRecoversAfterOversizedLine() {
  var framer = NDJSONLineFramer(maximumLineBytes: 8)
  let frames = framer.append(Data("123456789\n{}\n".utf8))
  #expect(frames == [.oversizedLine, .line(Data("{}".utf8))])
}

@Test func framerJoinsChunksAndAcceptsFinalLineWithoutNewline() {
  var framer = NDJSONLineFramer()
  #expect(framer.append(Data(#"{"id":"a""#.utf8)) == [])
  #expect(framer.append(Data(#", "type":"status"}"#.utf8)) == [])
  #expect(
    framer.finish() == [.line(Data(#"{"id":"a", "type":"status"}"#.utf8))]
  )
}
