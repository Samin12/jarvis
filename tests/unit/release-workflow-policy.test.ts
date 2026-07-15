import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const developmentBuilder = readFileSync(
  new URL('../../electron-builder.yml', import.meta.url),
  'utf8'
)
const draftWorkflow = readFileSync(
  new URL('../../.github/workflows/draft-release.yml', import.meta.url),
  'utf8'
)
const publishWorkflow = readFileSync(
  new URL('../../.github/workflows/publish-release.yml', import.meta.url),
  'utf8'
)

describe('trusted release workflows', () => {
  it('builds native arm64 and x64 PR previews only in unprivileged jobs', () => {
    expect(ciWorkflow).toContain('permissions:\n  contents: read')
    expect(ciWorkflow).toContain('persist-credentials: false')
    expect(ciWorkflow).toContain('name: Development package (${{ matrix.arch }})')
    expect(ciWorkflow).toContain("if: github.event_name == 'pull_request'")
    expect(ciWorkflow).toContain('runner: macos-15')
    expect(ciWorkflow).toContain('runner: macos-15-intel')
    expect(ciWorkflow).toContain("CSC_FOR_PULL_REQUEST: 'true'")
    expect(ciWorkflow).toContain('npm run verify:package:artifacts:dev')
    expect(ciWorkflow).toContain('jarvis-development-adhoc-pr-')
    expect(ciWorkflow).toContain('retention-days: 1')
    expect(ciWorkflow).toContain('compression-level: 0')
    expect(ciWorkflow).not.toContain('secrets.')
    expect(developmentBuilder).toContain(
      'artifactName: ${productName}-${version}-${arch}-mac.${ext}'
    )
  })

  it('uses a short-lived App Store Connect key and rejects retired Apple ID credentials', () => {
    expect(draftWorkflow).toContain('APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}')
    expect(draftWorkflow).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}')
    expect(draftWorkflow).toContain('APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}')
    expect(draftWorkflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}')
    expect(draftWorkflow).toContain('Remove the materialized notarization private key')
    expect(draftWorkflow).toContain('rm -f -- "$key_path"')
    expect(draftWorkflow).not.toMatch(/\bAPPLE_ID\b/u)
    expect(draftWorkflow).not.toContain('APPLE_APP_SPECIFIC_PASSWORD')
  })

  it('reverifies both native packages before protected draft publication', () => {
    expect(publishWorkflow).toContain('workflow_dispatch:')
    expect(publishWorkflow.match(/environment: release/gu)).toHaveLength(2)
    expect(publishWorkflow).toContain('runner: macos-15')
    expect(publishWorkflow).toContain('runner: macos-15-intel')
    expect(publishWorkflow).toContain('--summary-path "verification-${TARGET_ARCH}.json"')
    expect(publishWorkflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}')
    expect(publishWorkflow).toContain('assert-live-draft')
    expect(publishWorkflow).toContain('verify-assets')
    expect(publishWorkflow).toContain('cmp --silent release-view.json release-view-at-publish.json')
    expect(publishWorkflow).toContain('--draft=false')
  })

  it('requires immutable releases and keeps third-party actions pinned to full SHAs', () => {
    expect(publishWorkflow.match(/repos\/\$GITHUB_REPOSITORY\/immutable-releases/gu)).toHaveLength(
      2
    )
    expect(publishWorkflow).toContain('\'.isImmutable\' <<< "$published"')

    for (const workflow of [draftWorkflow, publishWorkflow]) {
      for (const line of workflow.split('\n').filter((value) => value.includes('uses: actions/'))) {
        expect(line).toMatch(/uses: actions\/[a-z-]+@[0-9a-f]{40}\s+#\s+v\d/u)
      }
    }
  })
})
