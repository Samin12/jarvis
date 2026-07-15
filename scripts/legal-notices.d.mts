export type LegalNoticeVerification = {
  schemaVersion: number
  componentCount: number
  fileCount: number
  codexTag: string
  manifestBytes: number
  manifestSha256: string
}

export function buildLegalNotices(directory: string): LegalNoticeVerification
export function verifyLegalNotices(directory: string): LegalNoticeVerification
