import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { PageContainer } from '@/components/layout'
import { UserForm } from '@/components/users/UserForm'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

export const Route = createFileRoute('/users/new')({
  component: NewUserPage,
})

function NewUserPage() {
  const navigate = useNavigate()
  const { alert } = useAlertDialog()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleCreateUser = async (data: any) => {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || 'Failed to create user')
      }

      // Navigate to the users list
      navigate({ to: '/users' })
    } catch (error) {
      console.error('Error creating user:', error)
      alert({
        title: 'Error',
        description: `Failed to create user: ${(error as Error).message}`,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/users' })
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/users">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Create New User
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Enter the details for the new user
          </p>
        </div>
      </div>

      {/* Form Card */}
      <Card>
        <CardHeader>
          <CardTitle>User Details</CardTitle>
          <CardDescription>
            All fields marked with * are required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UserForm
            mode="create"
            onSubmit={handleCreateUser}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
