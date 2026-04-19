/**
 * Well-known setting keys for the application.
 * This file is separated from SettingsService to allow client-side imports
 * without pulling in server-only database dependencies.
 */
export const SettingKeys = {
  VAULT_ROOT: 'vault_root',
  VAULT_TYPE: 'vault_type',
  VAULT_CONFIG: 'vault_config',
  MAX_FILE_SIZE: 'max_file_size',
} as const

export type SettingKey = (typeof SettingKeys)[keyof typeof SettingKeys]
