export type ExternalUrlPurpose = 'chatgpt-auth' | 'app-install' | 'documentation'

const HOSTS: Record<ExternalUrlPurpose, ReadonlySet<string>> = {
  'chatgpt-auth': new Set(['auth.openai.com', 'chatgpt.com']),
  'app-install': new Set(['chatgpt.com', 'platform.openai.com']),
  documentation: new Set(['github.com', 'help.openai.com', 'openai.com', 'support.apple.com'])
}

export function validateExternalUrl(raw: string, purpose: ExternalUrlPurpose): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192) {
    throw new Error('External URL is missing or too long')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('External URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS external URLs are allowed')
  if (url.username || url.password) throw new Error('Credential-bearing URLs are not allowed')
  if (url.port && url.port !== '443') throw new Error('Unexpected external URL port')
  if (!HOSTS[purpose].has(url.hostname.toLowerCase())) {
    throw new Error(`External host is not allowed for ${purpose}`)
  }
  return url
}
