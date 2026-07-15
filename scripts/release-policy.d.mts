export type ReleaseAsset = { name: string; digest: string; size: number }
export type ReleaseContract = {
  schemaVersion: 2
  repository: string
  tag: string
  commit: string
  packageName: string
  version: string
  title: string
  bodySha256: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

export function requireAppleTeamId(value: unknown): string
export function requireAppleApiKeyId(value: unknown): string
export function requireAppleApiIssuer(value: unknown): string
export function parseCodeSignatureMetadata(signature: unknown): {
  authorities: string[]
  teamIdentifier: string | null
}
export function assertDeveloperIdSignature(
  signature: unknown,
  expectedTeamId: unknown,
  label?: string
): { authorities: string[]; teamIdentifier: string | null }
export function expectedReleaseAssetNames(packageName: unknown, version: unknown): string[]
export function createReleaseContract(input: {
  releaseView: unknown
  tag: unknown
  commit: unknown
  packageJson: unknown
  repository: unknown
}): ReleaseContract
export function assertReleaseMatchesContract(
  contract: ReleaseContract,
  releaseView: unknown
): ReleaseAsset[]
export function assertPublishedReleaseMatchesContract(
  contract: ReleaseContract,
  releaseView: unknown
): ReleaseAsset[]
export function sha256PhysicalFile(path: string): { bytes: number; sha256: string }
export function verifyLocalReleaseAssets(
  contract: ReleaseContract,
  directory: string,
  arch?: 'arm64' | 'x64' | null
): Array<{ name: string; bytes: number; sha256: string }>
export function runReleasePolicyCli(argv: string[]): Promise<void>
