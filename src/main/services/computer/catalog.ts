export const COMPUTER_TOOL_NAMESPACE = 'jarvis_computer'
export const OPEN_APPLICATION_TOOL_NAME = 'open_application'

export const MAC_APP_IDS = Object.freeze(['calculator', 'calendar', 'notes'] as const)

export type MacAppId = (typeof MAC_APP_IDS)[number]

export interface MacApplicationDefinition {
  readonly id: MacAppId
  readonly displayName: string
  readonly applicationPath: string
  readonly bundleId: string
}

export const MAC_APPLICATION_CATALOG: Readonly<Record<MacAppId, MacApplicationDefinition>> =
  Object.freeze({
    calculator: Object.freeze({
      id: 'calculator',
      displayName: 'Calculator',
      applicationPath: '/System/Applications/Calculator.app',
      bundleId: 'com.apple.calculator'
    }),
    calendar: Object.freeze({
      id: 'calendar',
      displayName: 'Calendar',
      applicationPath: '/System/Applications/Calendar.app',
      bundleId: 'com.apple.iCal'
    }),
    notes: Object.freeze({
      id: 'notes',
      displayName: 'Notes',
      applicationPath: '/System/Applications/Notes.app',
      bundleId: 'com.apple.Notes'
    })
  })

export const OPEN_APPLICATION_DYNAMIC_TOOL = Object.freeze({
  name: OPEN_APPLICATION_TOOL_NAME,
  description:
    'Open one explicitly allowlisted macOS application after the user approves the exact action.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      appId: Object.freeze({
        type: 'string',
        enum: MAC_APP_IDS
      })
    }),
    required: Object.freeze(['appId']),
    additionalProperties: false
  })
})

export function isMacAppId(value: unknown): value is MacAppId {
  return typeof value === 'string' && (MAC_APP_IDS as readonly string[]).includes(value)
}
