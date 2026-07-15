export type ReleaseReceiptSummary = {
  schemaVersion: 1
  assetCount: number
  manifestSha256: string
  checksumsSha256: string
  licenseComponentCount: number
  legalComponentCount: number
  teamId: string
}

export function expectedReleaseReceiptNames(packageName: unknown, version: unknown): string[]
export function prepareReleaseReceipts(input: {
  assetsDir: string
  packageJson: unknown
  tag: unknown
  commit: unknown
  repository: unknown
  teamId: unknown
  runUrl: unknown
  titleOut: string
  bodyOut: string
}): ReleaseReceiptSummary
export function verifyReleaseReceipts(input: {
  assetsDir: string
  packageJson: unknown
  tag: unknown
  commit: unknown
  repository: unknown
  releaseView: unknown
}): ReleaseReceiptSummary
export function runReleaseReceiptsCli(argv: string[]): Promise<void>
