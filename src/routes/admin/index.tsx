import { Link, createFileRoute } from '@tanstack/react-router'
import {
  AlertCircle,
  CheckCircle,
  Cloud,
  FolderOpen,
  HardDrive,
  Key,
  Loader2,
  Lock,
  Package,
  Save,
  Settings,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { VaultConfigInfo } from '@/lib/vault/storage/storage-factory'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui'
import { SettingKeys } from '@/lib/config/SettingKeys'

export const Route = createFileRoute('/admin/')({
  component: AdminPage,
})

function AdminPage() {
  const [vaultConfig, setVaultConfig] = useState<VaultConfigInfo | null>(null)
  const [vaultLocation, setVaultLocation] = useState('')
  const [originalVaultLocation, setOriginalVaultLocation] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [errorMessage, setErrorMessage] = useState('')

  // Load existing vault configuration on mount
  useEffect(() => {
    loadVaultConfig()
  }, [])

  const loadVaultConfig = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/admin/vault-config')

      if (response.ok) {
        const data = await response.json()
        const config = data.data as VaultConfigInfo
        setVaultConfig(config)

        // For local storage, set the editable vault location
        if (config.type === 'local') {
          setVaultLocation(config.rootPath || '')
          setOriginalVaultLocation(config.dbSettings.vaultRoot || '')
        }
      }
    } catch (error) {
      console.error('Error loading vault config:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!vaultLocation.trim()) return

    try {
      setSaving(true)
      setSaveStatus('idle')
      setErrorMessage('')

      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: SettingKeys.VAULT_ROOT,
          value: vaultLocation.trim(),
          description: 'Root path for vault file storage',
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || 'Failed to save settings')
      }

      setOriginalVaultLocation(vaultLocation.trim())
      setSaveStatus('success')
      // Reload config to get updated sources
      await loadVaultConfig()
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch (error) {
      console.error('Error saving settings:', error)
      setSaveStatus('error')
      setErrorMessage((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // For local storage, check if the vault root is locked by env var
  const isVaultRootLocked =
    vaultConfig?.type === 'local' && vaultConfig?.envVars.VAULT_ROOT

  const hasChanges =
    vaultConfig?.type === 'local' &&
    !isVaultRootLocked &&
    vaultLocation.trim() !== originalVaultLocation

  // Helper to get source description
  const getSourceDescription = (
    source: 'env' | 'db' | 'default' | undefined,
    envVarName?: string,
  ) => {
    switch (source) {
      case 'env':
        return envVarName
          ? `From environment variable ${envVarName}`
          : 'From environment variable'
      case 'db':
        return 'Database override'
      case 'default':
        return 'Default value'
      default:
        return ''
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings className="w-8 h-8 text-slate-700 dark:text-slate-300" />
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Administration
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            System configuration and settings
          </p>
        </div>
      </div>

      {/* Vault Settings Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Vault Configuration</CardTitle>
          </div>
          <CardDescription>
            File storage configuration for the vault
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading configuration...
            </div>
          ) : vaultConfig ? (
            <div className="space-y-6">
              {/* Storage Type */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  Storage Type
                  {vaultConfig.sources.type === 'env' && (
                    <Lock className="w-3.5 h-3.5 text-amber-500" />
                  )}
                </Label>
                <div className="flex items-center gap-2">
                  {vaultConfig.type === 's3' ? (
                    <Badge variant="secondary" className="gap-1.5">
                      <Cloud className="w-3.5 h-3.5" />
                      S3 Object Storage
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1.5">
                      <HardDrive className="w-3.5 h-3.5" />
                      Local File System
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {getSourceDescription(vaultConfig.sources.type, 'VAULT_TYPE')}
                </p>
              </div>

              {/* S3 Configuration */}
              {vaultConfig.type === 's3' && (
                <div className="space-y-4 border-l-2 border-slate-300 dark:border-slate-700 pl-4">
                  <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
                    <Cloud className="w-4 h-4" />
                    S3 Configuration
                  </h4>

                  {/* Bucket */}
                  <div className="space-y-1">
                    <Label className="text-sm flex items-center gap-2">
                      Bucket
                      <Lock className="w-3 h-3 text-amber-500" />
                    </Label>
                    <Input
                      value={vaultConfig.bucket || ''}
                      disabled
                      className="bg-slate-50 dark:bg-slate-800"
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {getSourceDescription('env', 'S3_BUCKET')}
                    </p>
                  </div>

                  {/* Region */}
                  <div className="space-y-1">
                    <Label className="text-sm flex items-center gap-2">
                      Region
                      {vaultConfig.envVars.S3_REGION && (
                        <Lock className="w-3 h-3 text-amber-500" />
                      )}
                    </Label>
                    <Input
                      value={vaultConfig.region || 'us-east-1'}
                      disabled
                      className="bg-slate-50 dark:bg-slate-800"
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {getSourceDescription(
                        vaultConfig.sources.region,
                        'S3_REGION',
                      )}
                    </p>
                  </div>

                  {/* Key Prefix */}
                  {vaultConfig.keyPrefix && (
                    <div className="space-y-1">
                      <Label className="text-sm flex items-center gap-2">
                        Key Prefix
                        <Lock className="w-3 h-3 text-amber-500" />
                      </Label>
                      <Input
                        value={vaultConfig.keyPrefix}
                        disabled
                        className="bg-slate-50 dark:bg-slate-800"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {getSourceDescription('env', 'S3_KEY_PREFIX')}
                      </p>
                    </div>
                  )}

                  {/* Endpoint (for S3-compatible services) */}
                  {vaultConfig.endpoint && (
                    <div className="space-y-1">
                      <Label className="text-sm flex items-center gap-2">
                        Custom Endpoint
                        <Lock className="w-3 h-3 text-amber-500" />
                      </Label>
                      <Input
                        value={vaultConfig.endpoint}
                        disabled
                        className="bg-slate-50 dark:bg-slate-800"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {getSourceDescription('env', 'S3_ENDPOINT')}
                      </p>
                    </div>
                  )}

                  {/* Credentials Status */}
                  <div className="space-y-1">
                    <Label className="text-sm flex items-center gap-2">
                      <Key className="w-3.5 h-3.5" />
                      Credentials
                    </Label>
                    <div className="flex items-center gap-2">
                      {vaultConfig.hasCredentials ? (
                        <Badge
                          variant="secondary"
                          className="gap-1.5 text-green-700 dark:text-green-400"
                        >
                          <CheckCircle className="w-3 h-3" />
                          Configured (explicit keys)
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1.5">
                          <CheckCircle className="w-3 h-3" />
                          Using IAM role / instance profile
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Local Storage Configuration */}
              {vaultConfig.type === 'local' && (
                <div className="space-y-4 border-l-2 border-slate-300 dark:border-slate-700 pl-4">
                  <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
                    <HardDrive className="w-4 h-4" />
                    Local Storage
                  </h4>

                  <div className="space-y-2">
                    <Label
                      htmlFor="vaultLocation"
                      className="flex items-center gap-2"
                    >
                      Vault Location
                      {isVaultRootLocked && (
                        <Lock className="w-3 h-3 text-amber-500" />
                      )}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="vaultLocation"
                        type="text"
                        placeholder="C:\CascadiaVault or /var/cascadia/vault"
                        value={vaultLocation}
                        onChange={(e) => setVaultLocation(e.target.value)}
                        disabled={isVaultRootLocked}
                        className={
                          isVaultRootLocked
                            ? 'flex-1 bg-slate-50 dark:bg-slate-800'
                            : 'flex-1'
                        }
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        title="Browse"
                        disabled
                      >
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {getSourceDescription(
                        vaultConfig.sources.rootPath,
                        'VAULT_ROOT',
                      )}
                    </p>
                    {!isVaultRootLocked && (
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        Specify the directory path where vault files will be
                        stored. This location should be accessible by the
                        application and have adequate storage space.
                      </p>
                    )}
                  </div>

                  {/* Save button for local storage when editable */}
                  {!isVaultRootLocked && (
                    <div className="flex items-center gap-2 pt-2">
                      <Button
                        onClick={handleSave}
                        disabled={
                          !vaultLocation.trim() || saving || !hasChanges
                        }
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4 mr-2" />
                        )}
                        {saving ? 'Saving...' : 'Save Configuration'}
                      </Button>
                      {saveStatus === 'success' && (
                        <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                          <CheckCircle className="w-4 h-4" />
                          Settings saved!
                        </span>
                      )}
                      {saveStatus === 'error' && (
                        <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                          <AlertCircle className="w-4 h-4" />
                          {errorMessage || 'Failed to save'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-slate-600 dark:text-slate-400">
              Failed to load vault configuration.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Item Type Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Item Type Configuration</CardTitle>
          </div>
          <CardDescription>
            Configure permissions, states, and labels for item types
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Manage runtime configurations for Part, Document, Change Order,
              and other item types. Override code defaults without redeploying
              the application.
            </p>
            <Link to="/admin/item-types">
              <Button>
                <Settings className="w-4 h-4 mr-2" />
                Configure Item Types
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* User Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>User Management</CardTitle>
          </div>
          <CardDescription>
            Manage users, reset passwords, and view account status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              View all users, reset locked accounts, and manage passwords.
              Requires the users:manage permission.
            </p>
            <Link to="/admin/users">
              <Button>
                <Users className="w-4 h-4 mr-2" />
                Manage Users
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Component Catalog */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Component Catalog</CardTitle>
          </div>
          <CardDescription>
            Reference library of real, purchasable components and raw stock
            materials
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Manage the component catalog used by the design engine during BOM
              drafting. Browse, add, and import components with specs, pricing,
              and sourcing info.
            </p>
            <Link to="/admin/component-catalog">
              <Button>
                <Package className="w-4 h-4 mr-2" />
                Manage Catalog
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Additional Settings Placeholder */}
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle>Additional Settings</CardTitle>
          <CardDescription>Coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Additional system configuration options will be added here.
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
