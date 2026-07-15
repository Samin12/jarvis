# Jarvis macOS speech helper

`jarvis-macos-speech` is a small, zero-API-key push-to-talk helper for Jarvis. It uses Apple's `Speech` framework for transcription and `AVSpeechSynthesizer` for native text-to-speech. It never starts listening by itself; only an explicit `start` command opens the microphone, and every session has a hard 60-second ceiling.

## Build and test

```bash
swift test --package-path native/macos-speech
scripts/build-macos-speech.sh release
```

The build script selects the current architecture by default. Set `JARVIS_MACOS_SPEECH_ARCH=arm64` or `x86_64` to make an architecture-specific build. It prints the absolute binary path for packaging.

For a release, build separately on the matching architecture, stage the helper at `Resources/native/macos-speech/<arch>/jarvis-macos-speech`, sign the nested executable with the same Developer ID as the containing app, and then sign/notarize the outer app. Do not assemble a universal helper from unverified cross-builds.

The containing Electron app's `Info.plist` must include both:

- `NSMicrophoneUsageDescription`
- `NSSpeechRecognitionUsageDescription`

The helper intentionally has no network credentials and should be spawned with a minimal environment. Apple may use its speech service unless `requireOnDevice` is true and the selected locale supports on-device recognition.

The Electron main-process adapter lives in `src/main/services/voice/localMacSpeech`. Integration resolves a project-owned binary, launches it with an allowlisted environment, and subscribes to typed events:

```ts
const executablePath = await resolveLocalMacSpeechExecutable({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  projectRoot: app.getAppPath()
})
const voice = await LocalMacSpeechClient.launch({ executablePath })
voice.subscribe((event) => routeVoiceEvent(event))
voice.startListening({ maxDurationMs: 30_000 })
```

Keep this client in Electron's main process. The renderer should receive narrow, validated IPC methods for permission, start, stop, cancel, speak, and stop-speaking rather than a generic helper command channel.

## NDJSON protocol (version 1)

Write one JSON command per line to stdin. Read one JSON event per line from stdout. Lines are capped at 64 KiB. Command IDs are supplied by the caller and returned as `requestId` on correlated events.

Commands:

```json
{"id":"1","type":"status"}
{"id":"2","type":"permission"}
{"id":"3","type":"start","locale":"en-US","requireOnDevice":false,"maxDurationMs":30000}
{"id":"4","type":"stop"}
{"id":"5","type":"cancel"}
{"id":"6","type":"speak","text":"Good morning.","rate":0.5,"pitch":1,"volume":1}
{"id":"7","type":"stopSpeaking"}
{"id":"8","type":"shutdown"}
```

Events use this envelope:

```json
{"type":"transcript","protocolVersion":1,"requestId":"3","timestampMs":1710000000000,"data":{"sessionId":"...","text":"Good morning Jarvis","isFinal":true}}
```

Event types are `ready`, `status`, `permission`, `listeningState`, `transcript`, `speechState`, `error`, and `shutdown`. Errors carry stable `code`, `message`, and `recoverable` fields. No command accepts a path, URL, environment variable, or executable name.
