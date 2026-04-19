import { useForm } from '@tanstack/react-form'
import { userCreateSchema, userUpdateSchema } from '@/lib/auth/types'
import { zodValidator } from '@/lib/form-validation'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface UserFormProps {
  user?: {
    email?: string
    name?: string
    provider?: string
    providerId?: string
    active?: boolean
  }
  mode: 'create' | 'edit'
  onSubmit: (data: any) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function UserForm({
  user,
  mode,
  onSubmit,
  onCancel,
  isSubmitting,
}: UserFormProps) {
  const schema = mode === 'create' ? userCreateSchema : userUpdateSchema

  const form = useForm({
    defaultValues: {
      email: user?.email || '',
      name: user?.name || '',
      password: '',
      provider: user?.provider || 'local',
      providerId: user?.providerId || '',
      active: user?.active ?? true,
    },
    validators: {
      onSubmit: zodValidator(schema),
    },
    onSubmit: async ({ value }) => {
      await onSubmit(value)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Email */}
        <form.Field name="email">
          {(field) => (
            <FormField
              label="Email"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="User's email address (used for login)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                type="email"
                placeholder="user@example.com"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Name */}
        <form.Field name="name">
          {(field) => (
            <FormField
              label="Name"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="User's full name"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="John Doe"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Password (only for create mode) */}
        {mode === 'create' && (
          <form.Field name="password">
            {(field) => (
              <FormField
                label="Password"
                required
                error={field.state.meta.errors[0] as string | undefined}
                helpText="Minimum 8 characters"
              >
                <Input
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  type="password"
                  placeholder="••••••••"
                  error={!!field.state.meta.errors.length}
                />
              </FormField>
            )}
          </form.Field>
        )}

        {/* Provider */}
        <form.Field name="provider">
          {(field) => (
            <FormField
              label="Provider"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Authentication provider"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
              >
                <SelectTrigger error={field.state.meta.errors.length > 0}>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="azure">Azure AD</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Provider ID (only if provider is not local) */}
        <form.Field name="provider">
          {(providerField) => (
            <>
              {providerField.state.value !== 'local' && (
                <form.Field name="providerId">
                  {(field) => (
                    <FormField
                      label="Provider ID"
                      error={field.state.meta.errors[0] as string | undefined}
                      helpText="External provider user ID"
                    >
                      <Input
                        name={field.name}
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        placeholder="External ID"
                        error={!!field.state.meta.errors.length}
                      />
                    </FormField>
                  )}
                </form.Field>
              )}
            </>
          )}
        </form.Field>

        {/* Active Status */}
        <form.Field name="active">
          {(field) => (
            <FormField
              label="Active Status"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Active users can log in"
            >
              <Select
                value={field.state.value ? 'true' : 'false'}
                onValueChange={(value) => field.handleChange(value === 'true')}
              >
                <SelectTrigger error={field.state.meta.errors.length > 0}>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Active</SelectItem>
                  <SelectItem value="false">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Form Actions */}
      <div className="flex justify-end gap-4 pt-4 border-t">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Saving...'
            : mode === 'create'
              ? 'Create User'
              : 'Update User'}
        </Button>
      </div>
    </form>
  )
}
