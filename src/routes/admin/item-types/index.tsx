import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  Cog,
  Edit,
  Package,
  RefreshCw,
  Settings,
} from 'lucide-react'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

export const Route = createFileRoute('/admin/item-types/')({
  component: ItemTypesConfigPage,
})

interface StateConfig {
  id: string
  name: string
  color?: string
  description?: string
}

interface PermissionConfig {
  create: Array<string>
  read: Array<string>
  update: Array<string>
  delete: Array<string>
}

interface RelationshipConfig {
  type: string
  label: string
  targetTypes: Array<string>
  allowMultiple: boolean
}

interface ItemTypeConfigSummary {
  itemType: string
  hasCodeDefinition: boolean
  hasRuntimeConfig: boolean
  codeConfig: {
    label: string
    pluralLabel: string
    icon: string
    states: Array<StateConfig>
    permissions: PermissionConfig
    relationships: Array<RelationshipConfig>
  } | null
  runtimeConfig: {
    id: string
    version: number
    isActive: boolean
    config: any
    modifiedAt: string
    modifiedBy: string
  } | null
  mergedConfig: {
    label: string
    pluralLabel: string
    icon: string
    states: Array<StateConfig>
    permissions: PermissionConfig
    relationships: Array<RelationshipConfig>
  }
}

function ItemTypesConfigPage() {
  const [configs, setConfigs] = useState<Array<ItemTypeConfigSummary>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    fetchConfigs()
  }, [])

  const fetchConfigs = async () => {
    try {
      setError(null)
      const response = await fetch('/api/admin/item-type-configs')
      if (!response.ok) {
        const data = await response.json()
        throw new Error(
          data.error?.message || 'Failed to fetch item type configs',
        )
      }
      const data = await response.json()
      setConfigs(data.data.configs)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleReloadConfigs = async () => {
    setReloading(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const response = await fetch('/api/admin/reload-config', {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(
          data.error?.message || 'Failed to reload configurations',
        )
      }

      await fetchConfigs()
      setSuccessMessage('Configurations reloaded successfully')
      setTimeout(() => setSuccessMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setReloading(false)
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <p className="text-slate-600 dark:text-slate-400">
          Loading configurations...
        </p>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings className="w-8 h-8 text-slate-700 dark:text-slate-300" />
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Item Type Configuration
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-2">
              Configure permissions, states, and labels for item types
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="secondary">
            {configs.length} {configs.length === 1 ? 'Type' : 'Types'}
          </Badge>
          <Button
            variant="outline"
            onClick={handleReloadConfigs}
            disabled={reloading}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${reloading ? 'animate-spin' : ''}`}
            />
            {reloading ? 'Reloading...' : 'Reload All'}
          </Button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        </div>
      )}

      {/* Success message */}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            {successMessage}
          </div>
        </div>
      )}

      {/* Info card */}
      <Card className="bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Cog className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5" />
            <div className="space-y-2 text-sm">
              <p className="text-blue-900 dark:text-blue-100">
                <strong>Code-First Configuration:</strong> Item types are
                defined in code with TypeScript type safety. Runtime
                configurations allow you to override labels, permissions,
                states, and relationships without redeploying.
              </p>
              <p className="text-blue-800 dark:text-blue-200">
                Changes to runtime configurations take effect immediately and
                can be reloaded without restarting the application.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Item type cards */}
      <div className="grid gap-6 md:grid-cols-2">
        {configs.map((config) => (
          <Card key={config.itemType}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-slate-600 dark:text-slate-400" />
                  <div>
                    <CardTitle>{config.mergedConfig.label}</CardTitle>
                    <CardDescription>
                      Type: <code className="text-xs">{config.itemType}</code>
                    </CardDescription>
                  </div>
                </div>
                <Link
                  to="/admin/item-types/$itemType"
                  params={{ itemType: config.itemType }}
                >
                  <Button variant="outline" size="sm">
                    <Edit className="w-4 h-4 mr-2" />
                    Configure
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status badges */}
              <div className="flex gap-2">
                <Badge variant="secondary">Code Definition</Badge>
                {config.hasRuntimeConfig && (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    Runtime Override
                    {config.runtimeConfig &&
                      ` (v${config.runtimeConfig.version})`}
                  </Badge>
                )}
              </div>

              {/* States */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  States ({config.mergedConfig.states.length}):
                </h4>
                <div className="flex flex-wrap gap-1">
                  {config.mergedConfig.states.slice(0, 5).map((state) => (
                    <Badge key={state.id} variant="outline" className="text-xs">
                      {state.name}
                    </Badge>
                  ))}
                  {config.mergedConfig.states.length > 5 && (
                    <Badge variant="outline" className="text-xs">
                      +{config.mergedConfig.states.length - 5} more
                    </Badge>
                  )}
                </div>
              </div>

              {/* Create Permissions */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Create Permissions:
                </h4>
                <div className="flex flex-wrap gap-1">
                  {config.mergedConfig.permissions.create.map((perm, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs">
                      {perm === '*' ? 'All Roles' : perm}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Relationships */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Relationships ({config.mergedConfig.relationships.length}):
                </h4>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {config.mergedConfig.relationships
                    .map((rel) => rel.label)
                    .join(', ') || 'None defined'}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {configs.length === 0 && (
        <Card className="text-center py-12">
          <CardContent>
            <Package className="w-12 h-12 mx-auto text-slate-400 mb-4" />
            <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-300">
              No Item Types Found
            </h3>
            <p className="text-slate-500 dark:text-slate-400 mt-2">
              Item types should be registered in code. Check the server logs for
              registration errors.
            </p>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  )
}
