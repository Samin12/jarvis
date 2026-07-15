export const JARVIS_ASSISTANT_PERMISSION_PROFILE = 'jarvis_assistant'
export const JARVIS_TASK_PERMISSION_PROFILE = 'jarvis_task'

/**
 * Installed into Jarvis' private CODEX_HOME on every launch. Neither profile
 * grants `:root` or workspace access. Task workspace I/O is performed only by
 * the host-owned dynamic namespace after TaskRecord binding checks.
 */
export const JARVIS_CODEX_CONFIG_TOML = `default_permissions = "${JARVIS_ASSISTANT_PERMISSION_PROFILE}"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"

[analytics]
enabled = false

[permissions.${JARVIS_ASSISTANT_PERMISSION_PROFILE}]
description = "Jarvis conversation lane with no workspace or credential access"

[permissions.${JARVIS_ASSISTANT_PERMISSION_PROFILE}.filesystem]
":minimal" = "read"

[permissions.${JARVIS_ASSISTANT_PERMISSION_PROFILE}.network]
enabled = false

[permissions.${JARVIS_TASK_PERMISSION_PROFILE}]
description = "Jarvis Codex lane with workspace access owned by the Jarvis host"

[permissions.${JARVIS_TASK_PERMISSION_PROFILE}.filesystem]
":minimal" = "read"

[permissions.${JARVIS_TASK_PERMISSION_PROFILE}.network]
enabled = false
`

export const DISABLED_LOCAL_TOOL_CONFIG = Object.freeze({
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.browser_use': false,
  'features.browser_use_full_cdp_access': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.computer_use': false,
  'features.image_generation': false,
  'features.tool_suggest': false,
  web_search: 'disabled'
} as const)

export const TASK_TOOL_CONFIG = Object.freeze({
  ...DISABLED_LOCAL_TOOL_CONFIG,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.plugin_sharing': false
} as const)
