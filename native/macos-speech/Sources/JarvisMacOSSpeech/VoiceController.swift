import AVFoundation
import Darwin
import Foundation
import JarvisMacOSSpeechCore
import Speech

private final class ListeningSession {
  let sessionId = UUID().uuidString
  let startRequestId: String
  var latestTranscript = ""
  var isStopping = false
  var terminalRequestId: String
  var stopReason: String?

  init(startRequestId: String) {
    self.startRequestId = startRequestId
    terminalRequestId = startRequestId
  }
}

private final class SpeechSession {
  let sessionId = UUID().uuidString
  let speakRequestId: String
  let utterance: AVSpeechUtterance
  var terminalRequestId: String

  init(speakRequestId: String, utterance: AVSpeechUtterance) {
    self.speakRequestId = speakRequestId
    self.utterance = utterance
    terminalRequestId = speakRequestId
  }
}

/// All mutable AVFoundation/Speech state is confined to DispatchQueue.main.
final class VoiceController: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  private let emitter: EventEmitter
  private let synthesizer = AVSpeechSynthesizer()

  private var recognizer: SFSpeechRecognizer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var audioEngine: AVAudioEngine?
  private var tapInstalled = false
  private var listeningSession: ListeningSession?
  private var speechSession: SpeechSession?
  private var maximumDurationWorkItem: DispatchWorkItem?
  private var finalizationWorkItem: DispatchWorkItem?
  private var permissionRequestInFlight = false
  private var shuttingDown = false

  init(emitter: EventEmitter) {
    self.emitter = emitter
    super.init()
    synthesizer.delegate = self
  }

  func handle(_ command: VoiceCommand) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !shuttingDown else { return }

    switch command {
    case .status(let id):
      emitStatus(requestId: id)
    case .requestPermission(let id):
      requestPermissions(requestId: id)
    case .start(let id, let options):
      startListening(requestId: id, options: options)
    case .stop(let id):
      stopListening(requestId: id, reason: "user_stopped")
    case .cancel(let id):
      cancelListening(requestId: id, reason: "user_cancelled")
    case .speak(let id, let options):
      speak(requestId: id, options: options)
    case .stopSpeaking(let id):
      stopSpeaking(requestId: id)
    case .shutdown(let id):
      shutdown(requestId: id, reason: "requested")
    }
  }

  func emitStatus(requestId: String) {
    let locale = recognizer?.locale.identifier ?? Locale.current.identifier
    let statusRecognizer = recognizer ?? SFSpeechRecognizer(locale: Locale(identifier: locale))
    emitter.emit(
      type: "status",
      requestId: requestId,
      payload: StatusPayload(
        speechAuthorization: speechAuthorizationName(SFSpeechRecognizer.authorizationStatus()),
        microphoneAuthorization: microphoneAuthorizationName(
          AVCaptureDevice.authorizationStatus(for: .audio)
        ),
        recognizerAvailable: statusRecognizer?.isAvailable ?? false,
        supportsOnDeviceRecognition: statusRecognizer?.supportsOnDeviceRecognition ?? false,
        locale: locale,
        listening: listeningSession != nil,
        speaking: synthesizer.isSpeaking
      )
    )
  }

  private func requestPermissions(requestId: String) {
    guard !permissionRequestInFlight else {
      emitter.emitError(
        requestId: requestId,
        code: "permission_request_in_progress",
        message: "A permission request is already in progress.",
        recoverable: true
      )
      return
    }
    permissionRequestInFlight = true

    let requestMicrophoneAndFinish = { [weak self] in
      guard let self else { return }
      if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
          DispatchQueue.main.async {
            self?.finishPermissionRequest(requestId: requestId)
          }
        }
      } else {
        self.finishPermissionRequest(requestId: requestId)
      }
    }

    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      SFSpeechRecognizer.requestAuthorization { _ in
        DispatchQueue.main.async(execute: requestMicrophoneAndFinish)
      }
    } else {
      requestMicrophoneAndFinish()
    }
  }

  private func finishPermissionRequest(requestId: String) {
    permissionRequestInFlight = false
    emitter.emit(
      type: "permission",
      requestId: requestId,
      payload: PermissionPayload(
        speechAuthorization: speechAuthorizationName(SFSpeechRecognizer.authorizationStatus()),
        microphoneAuthorization: microphoneAuthorizationName(
          AVCaptureDevice.authorizationStatus(for: .audio)
        )
      )
    )
  }

  private func startListening(requestId: String, options: StartListeningOptions) {
    guard listeningSession == nil else {
      emitter.emitError(
        requestId: requestId,
        code: "listening_in_progress",
        message: "A push-to-talk session is already active.",
        recoverable: true
      )
      return
    }
    guard speechSession == nil, !synthesizer.isSpeaking else {
      emitter.emitError(
        requestId: requestId,
        code: "speech_in_progress",
        message: "Stop Jarvis speech before opening the microphone.",
        recoverable: true
      )
      return
    }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
      emitter.emitError(
        requestId: requestId,
        code: "speech_permission_required",
        message: "Speech recognition permission is required.",
        recoverable: true
      )
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      emitter.emitError(
        requestId: requestId,
        code: "microphone_permission_required",
        message: "Microphone permission is required.",
        recoverable: true
      )
      return
    }
    guard let selectedRecognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale))
    else {
      emitter.emitError(
        requestId: requestId,
        code: "unsupported_locale",
        message: "Speech recognition is unavailable for locale \(options.locale).",
        recoverable: true
      )
      return
    }
    guard selectedRecognizer.isAvailable else {
      emitter.emitError(
        requestId: requestId,
        code: "recognizer_unavailable",
        message: "The macOS speech recognizer is temporarily unavailable.",
        recoverable: true
      )
      return
    }
    if options.requiresOnDeviceRecognition && !selectedRecognizer.supportsOnDeviceRecognition {
      emitter.emitError(
        requestId: requestId,
        code: "on_device_unavailable",
        message: "On-device recognition is unavailable for locale \(options.locale).",
        recoverable: true
      )
      return
    }

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
      emitter.emitError(
        requestId: requestId,
        code: "microphone_unavailable",
        message: "No usable microphone input format is available.",
        recoverable: true
      )
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition

    let session = ListeningSession(startRequestId: requestId)
    recognizer = selectedRecognizer
    recognitionRequest = request
    audioEngine = engine
    listeningSession = session

    inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true

    recognitionTask = selectedRecognizer.recognitionTask(with: request) {
      [weak self] result, error in
      DispatchQueue.main.async {
        self?.handleRecognitionCallback(
          sessionId: session.sessionId,
          result: result,
          error: error
        )
      }
    }

    do {
      engine.prepare()
      try engine.start()
    } catch {
      let nsError = error as NSError
      cleanupRecognition(cancelTask: true)
      listeningSession = nil
      emitter.emitError(
        requestId: requestId,
        code: "audio_engine_failed",
        message: "The microphone audio engine could not start.",
        recoverable: true,
        domain: nsError.domain,
        nativeCode: nsError.code
      )
      return
    }

    emitter.emit(
      type: "listeningState",
      requestId: requestId,
      payload: ListeningStatePayload(
        state: "started",
        sessionId: session.sessionId,
        startRequestId: session.startRequestId,
        reason: nil
      )
    )

    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.listeningSession?.sessionId == session.sessionId else { return }
      self.stopListening(requestId: requestId, reason: "max_duration")
    }
    maximumDurationWorkItem = timeout
    DispatchQueue.main.asyncAfter(
      deadline: .now() + .milliseconds(options.maximumDurationMilliseconds),
      execute: timeout
    )
  }

  private func stopListening(requestId: String, reason: String) {
    guard let session = listeningSession else {
      emitter.emitError(
        requestId: requestId,
        code: "not_listening",
        message: "There is no active push-to-talk session.",
        recoverable: true
      )
      return
    }
    guard !session.isStopping else {
      emitter.emitError(
        requestId: requestId,
        code: "already_stopping",
        message: "The active push-to-talk session is already stopping.",
        recoverable: true
      )
      return
    }

    session.isStopping = true
    session.terminalRequestId = requestId
    session.stopReason = reason
    maximumDurationWorkItem?.cancel()
    maximumDurationWorkItem = nil
    stopAudioCapture()
    recognitionRequest?.endAudio()

    emitter.emit(
      type: "listeningState",
      requestId: requestId,
      payload: ListeningStatePayload(
        state: "stopping",
        sessionId: session.sessionId,
        startRequestId: session.startRequestId,
        reason: reason
      )
    )

    let fallback = DispatchWorkItem { [weak self] in
      guard let self, self.listeningSession?.sessionId == session.sessionId else { return }
      self.finalizeUsingLatestTranscript(session: session)
    }
    finalizationWorkItem = fallback
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(2_500), execute: fallback)
  }

  private func cancelListening(requestId: String, reason: String) {
    guard let session = listeningSession else {
      emitter.emitError(
        requestId: requestId,
        code: "not_listening",
        message: "There is no active push-to-talk session.",
        recoverable: true
      )
      return
    }
    listeningSession = nil
    cleanupRecognition(cancelTask: true)
    emitter.emit(
      type: "listeningState",
      requestId: requestId,
      payload: ListeningStatePayload(
        state: "cancelled",
        sessionId: session.sessionId,
        startRequestId: session.startRequestId,
        reason: reason
      )
    )
  }

  private func handleRecognitionCallback(
    sessionId: String,
    result: SFSpeechRecognitionResult?,
    error: Error?
  ) {
    guard let session = listeningSession, session.sessionId == sessionId else { return }

    if let result {
      let transcript = result.bestTranscription.formattedString
      session.latestTranscript = transcript
      emitter.emit(
        type: "transcript",
        requestId: session.startRequestId,
        payload: TranscriptPayload(
          sessionId: session.sessionId,
          text: transcript,
          isFinal: result.isFinal
        )
      )
      if result.isFinal {
        finishRecognition(session: session, state: "stopped", cancelTask: false)
        return
      }
    }

    guard let error else { return }
    if session.isStopping {
      finalizeUsingLatestTranscript(session: session)
      return
    }

    let nsError = error as NSError
    emitter.emitError(
      requestId: session.startRequestId,
      code: "recognition_failed",
      message: "Speech recognition stopped unexpectedly.",
      recoverable: true,
      domain: nsError.domain,
      nativeCode: nsError.code
    )
    finishRecognition(session: session, state: "failed", cancelTask: true)
  }

  private func finalizeUsingLatestTranscript(session: ListeningSession) {
    guard listeningSession?.sessionId == session.sessionId else { return }
    if !session.latestTranscript.isEmpty {
      emitter.emit(
        type: "transcript",
        requestId: session.startRequestId,
        payload: TranscriptPayload(
          sessionId: session.sessionId,
          text: session.latestTranscript,
          isFinal: true
        )
      )
    }
    finishRecognition(session: session, state: "stopped", cancelTask: true)
  }

  private func finishRecognition(
    session: ListeningSession,
    state: String,
    cancelTask: Bool
  ) {
    guard listeningSession?.sessionId == session.sessionId else { return }
    listeningSession = nil
    cleanupRecognition(cancelTask: cancelTask)
    emitter.emit(
      type: "listeningState",
      requestId: session.terminalRequestId,
      payload: ListeningStatePayload(
        state: state,
        sessionId: session.sessionId,
        startRequestId: session.startRequestId,
        reason: session.stopReason
      )
    )
  }

  private func cleanupRecognition(cancelTask: Bool) {
    maximumDurationWorkItem?.cancel()
    maximumDurationWorkItem = nil
    finalizationWorkItem?.cancel()
    finalizationWorkItem = nil
    stopAudioCapture()
    recognitionRequest?.endAudio()
    if cancelTask {
      recognitionTask?.cancel()
    }
    recognitionTask = nil
    recognitionRequest = nil
    audioEngine = nil
    recognizer = nil
  }

  private func stopAudioCapture() {
    audioEngine?.stop()
    if tapInstalled {
      audioEngine?.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
  }

  private func speak(requestId: String, options: SpeakOptions) {
    guard listeningSession == nil else {
      emitter.emitError(
        requestId: requestId,
        code: "listening_in_progress",
        message: "Close the microphone before starting speech output.",
        recoverable: true
      )
      return
    }
    guard speechSession == nil, !synthesizer.isSpeaking else {
      emitter.emitError(
        requestId: requestId,
        code: "speech_in_progress",
        message: "Jarvis is already speaking.",
        recoverable: true
      )
      return
    }

    let utterance = AVSpeechUtterance(string: options.text)
    if let identifier = options.voiceIdentifier {
      guard let voice = AVSpeechSynthesisVoice(identifier: identifier) else {
        emitter.emitError(
          requestId: requestId,
          code: "voice_not_found",
          message: "The requested macOS voice is not installed.",
          recoverable: true
        )
        return
      }
      utterance.voice = voice
    }
    if let normalizedRate = options.rate {
      let minimum = AVSpeechUtteranceMinimumSpeechRate
      let maximum = AVSpeechUtteranceMaximumSpeechRate
      utterance.rate = minimum + Float(normalizedRate) * (maximum - minimum)
    }
    utterance.pitchMultiplier = Float(options.pitch)
    utterance.volume = Float(options.volume)

    speechSession = SpeechSession(speakRequestId: requestId, utterance: utterance)
    synthesizer.speak(utterance)
  }

  private func stopSpeaking(requestId: String) {
    guard let session = speechSession, synthesizer.isSpeaking else {
      emitter.emitError(
        requestId: requestId,
        code: "not_speaking",
        message: "Jarvis is not currently speaking.",
        recoverable: true
      )
      return
    }
    session.terminalRequestId = requestId
    if !synthesizer.stopSpeaking(at: .immediate) {
      speechSession = nil
      emitter.emit(
        type: "speechState",
        requestId: requestId,
        payload: SpeechStatePayload(
          state: "cancelled",
          sessionId: session.sessionId,
          speakRequestId: session.speakRequestId,
          reason: "stop_unavailable"
        )
      )
    }
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didStart utterance: AVSpeechUtterance
  ) {
    guard let session = speechSession, session.utterance === utterance else { return }
    emitter.emit(
      type: "speechState",
      requestId: session.speakRequestId,
      payload: SpeechStatePayload(
        state: "started",
        sessionId: session.sessionId,
        speakRequestId: session.speakRequestId,
        reason: nil
      )
    )
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    guard let session = speechSession, session.utterance === utterance else { return }
    speechSession = nil
    emitter.emit(
      type: "speechState",
      requestId: session.speakRequestId,
      payload: SpeechStatePayload(
        state: "finished",
        sessionId: session.sessionId,
        speakRequestId: session.speakRequestId,
        reason: nil
      )
    )
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    guard let session = speechSession, session.utterance === utterance else { return }
    speechSession = nil
    emitter.emit(
      type: "speechState",
      requestId: session.terminalRequestId,
      payload: SpeechStatePayload(
        state: "cancelled",
        sessionId: session.sessionId,
        speakRequestId: session.speakRequestId,
        reason: "user_stopped"
      )
    )
  }

  func shutdown(requestId: String?, reason: String) {
    guard !shuttingDown else { return }
    shuttingDown = true
    permissionRequestInFlight = false

    if let session = listeningSession {
      listeningSession = nil
      cleanupRecognition(cancelTask: true)
      emitter.emit(
        type: "listeningState",
        requestId: requestId,
        payload: ListeningStatePayload(
          state: "cancelled",
          sessionId: session.sessionId,
          startRequestId: session.startRequestId,
          reason: "shutdown"
        )
      )
    }
    if let session = speechSession {
      speechSession = nil
      _ = synthesizer.stopSpeaking(at: .immediate)
      emitter.emit(
        type: "speechState",
        requestId: requestId,
        payload: SpeechStatePayload(
          state: "cancelled",
          sessionId: session.sessionId,
          speakRequestId: session.speakRequestId,
          reason: "shutdown"
        )
      )
    }

    emitter.emit(type: "shutdown", requestId: requestId, payload: ["reason": reason])
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(10)) {
      exit(EXIT_SUCCESS)
    }
  }

  private func speechAuthorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
  }

  private func microphoneAuthorizationName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
  }
}
