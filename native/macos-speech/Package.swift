// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "JarvisMacOSSpeech",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "jarvis-macos-speech", targets: ["JarvisMacOSSpeech"]),
    .executable(name: "jarvis-workspace-helper", targets: ["JarvisWorkspaceHelper"])
  ],
  targets: [
    .target(name: "JarvisMacOSSpeechCore"),
    .executableTarget(
      name: "JarvisMacOSSpeech",
      dependencies: ["JarvisMacOSSpeechCore"],
      linkerSettings: [
        .linkedFramework("AVFoundation"),
        .linkedFramework("Speech"),
      ]
    ),
    .executableTarget(name: "JarvisWorkspaceHelper"),
    .testTarget(
      name: "JarvisMacOSSpeechCoreTests",
      dependencies: ["JarvisMacOSSpeechCore"]
    ),
  ]
)
