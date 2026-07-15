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

  it('builds the exact eleven-asset draft with complete receipts and prepared metadata', () => {
    expect(draftWorkflow).toContain(
      '--summary-path "dist/jarvis-${package_version}-${TARGET_ARCH}-verification.json"'
    )
    expect(draftWorkflow).toContain('dist/jarvis-*-${{ matrix.arch }}-verification.json')
    expect(draftWorkflow).toContain('merge-multiple: true')
    expect(draftWorkflow).toContain('npm sbom')
    expect(draftWorkflow).toContain('--package-lock-only')
    expect(draftWorkflow).toContain('--sbom-format=cyclonedx')
    expect(draftWorkflow).toContain('--sbom-type=application')
    expect(draftWorkflow).toContain("jq -S 'del(.serialNumber, .metadata.timestamp)'")
    expect(draftWorkflow).not.toContain('--omit=dev')
    expect(draftWorkflow).toContain('npm run verify:legal')
    expect(draftWorkflow).toContain('dist/jarvis-${package_version}-third-party-notices.zip')
    expect(draftWorkflow).toContain("if: matrix.arch == 'arm64'")
    expect(draftWorkflow).toContain('node scripts/release-receipts.mjs prepare')
    expect(draftWorkflow).toContain('--title-out release-title.txt')
    expect(draftWorkflow).toContain('--body-out release-notes.md')
    expect(draftWorkflow).toContain('expectedReleaseAssetNames')
    expect(draftWorkflow).toContain('entries.length !== 11')
    expect(draftWorkflow).toContain('if [[ ${#assets[@]} -ne 11 ]]')
    expect(draftWorkflow).toContain('--notes-file release-notes.md')
    expect(draftWorkflow).toContain('--title "$(< release-title.txt)"')
    expect(draftWorkflow).toContain('Create or safely reuse and verify the exact draft')
    expect(draftWorkflow).toContain('validate_reusable_draft')
    expect(draftWorkflow).toContain(
      'Removing the exact partial draft created by this failed upload or verification'
    )
    expect(draftWorkflow).toContain('--json tagName,name,isDraft,isPrerelease,assets,body')
    expect(draftWorkflow).toContain('node scripts/release-policy.mjs assert-live-draft')
    expect(draftWorkflow).toContain('node scripts/release-policy.mjs verify-assets')
    expect(draftWorkflow).toContain('node scripts/release-receipts.mjs verify')
  })

  it('reverifies only native installers and publishes the unchanged eleven-asset draft', () => {
    expect(publishWorkflow).toContain('workflow_dispatch:')
    expect(publishWorkflow.match(/environment: release/gu)).toHaveLength(2)
    expect(publishWorkflow).toContain('Capture the exact eleven-asset draft contract')
    expect(publishWorkflow).toContain('--json tagName,name,isDraft,isPrerelease,assets,body')
    expect(publishWorkflow).toContain('runner: macos-15')
    expect(publishWorkflow).toContain('runner: macos-15-intel')
    expect(publishWorkflow).toContain('names.length !== 2')
    expect(publishWorkflow).toContain('npm run verify:package')
    expect(publishWorkflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}')
    expect(publishWorkflow).toContain('assert-live-draft')
    expect(publishWorkflow).toContain('verify-assets')
    expect(publishWorkflow).toContain('node scripts/release-receipts.mjs verify')
    expect(publishWorkflow).toContain('cmp --silent release-view.json release-view-at-publish.json')
    expect(publishWorkflow).toContain('--draft=false')
    expect(publishWorkflow).not.toContain('render-notes')
    expect(publishWorkflow).not.toContain('--notes-file')
    expect(publishWorkflow).toContain(
      '--json tagName,name,isDraft,isPrerelease,isImmutable,assets,body'
    )
    expect(publishWorkflow).toContain('node scripts/release-policy.mjs assert-published')
    expect(publishWorkflow).not.toContain('jarvis-promotion-evidence-')

    expect(publishWorkflow.indexOf('node scripts/release-receipts.mjs verify')).toBeLessThan(
      publishWorkflow.indexOf('gh release edit "$RELEASE_TAG"')
    )
    expect(
      publishWorkflow.indexOf('node scripts/release-policy.mjs assert-published')
    ).toBeGreaterThan(publishWorkflow.indexOf('gh release edit "$RELEASE_TAG"'))
  })

  it('isolates write tokens, requires immutable releases, and pins third-party actions', () => {
    expect(publishWorkflow.match(/repos\/\$GITHUB_REPOSITORY\/immutable-releases/gu)).toHaveLength(
      2
    )
    expect(draftWorkflow).not.toContain('    env:\n      GH_TOKEN: ${{ github.token }}')
    expect(publishWorkflow).not.toContain('    env:\n      GH_TOKEN: ${{ github.token }}')
    expect(draftWorkflow).toContain("GH_TOKEN: ''")
    expect(publishWorkflow).toContain("GH_TOKEN: ''")
    expect(draftWorkflow).toContain("GH_TOKEN='' node scripts/release-policy.mjs capture")
    expect(publishWorkflow).toContain("GH_TOKEN='' node scripts/release-policy.mjs capture")
    expect(publishWorkflow).toContain(
      "GH_TOKEN='' node scripts/release-policy.mjs assert-published"
    )

    for (const workflow of [draftWorkflow, publishWorkflow]) {
      for (const line of workflow.split('\n').filter((value) => value.includes('uses: actions/'))) {
        expect(line).toMatch(/uses: actions\/[a-z-]+@[0-9a-f]{40}\s+#\s+v\d/u)
      }
    }
  })
})
