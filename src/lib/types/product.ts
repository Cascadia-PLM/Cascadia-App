import type { products } from '@/lib/db/schema/products'

export type Product = typeof products.$inferSelect

export type CreateProductInput = {
  programId?: string | null
  name: string
  code: string
  description?: string
  productType?: 'product' | 'library'
  plannedQuantity?: number
}

export type UpdateProductInput = Partial<
  Omit<CreateProductInput, 'productType'>
>
