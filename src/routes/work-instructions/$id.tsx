import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/work-instructions/$id')({
  component: WorkInstructionLayout,
})

function WorkInstructionLayout() {
  return <Outlet />
}
