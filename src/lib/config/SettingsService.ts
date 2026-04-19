import { eq } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'

// Re-export for backward compatibility with server-side code
export { SettingKeys, type SettingKey } from './SettingKeys'

export interface SettingRecord {
  id: string
  key: string
  value: string | null
  jsonValue: unknown | null
  description: string | null
  modifiedAt: Date
  modifiedBy: string
}

/**
 * Service for managing application settings.
 * Provides CRUD operations for the settings table.
 */
export class SettingsService {
  /**
   * Get a setting by key
   */
  static async get(key: string): Promise<SettingRecord | null> {
    const results = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1)

    return (results[0] as SettingRecord | undefined) ?? null
  }

  /**
   * Get a text value setting
   */
  static async getValue(key: string): Promise<string | null> {
    const setting = await this.get(key)
    return setting?.value ?? null
  }

  /**
   * Get a JSON value setting
   */
  static async getJsonValue<T>(key: string): Promise<T | null> {
    const setting = await this.get(key)
    return (setting?.jsonValue as T) ?? null
  }

  /**
   * Get multiple settings by keys
   */
  static async getMany(
    keys: Array<string>,
  ): Promise<Map<string, SettingRecord>> {
    const results = await db.select().from(settings)

    const map = new Map<string, SettingRecord>()
    for (const result of results) {
      if (keys.includes(result.key)) {
        map.set(result.key, result as SettingRecord)
      }
    }

    return map
  }

  /**
   * Get all settings
   */
  static async getAll(): Promise<Array<SettingRecord>> {
    const results = await db.select().from(settings)
    return results as Array<SettingRecord>
  }

  /**
   * Set a text value setting (upsert)
   */
  static async setValue(
    key: string,
    value: string,
    userId: string,
    description?: string,
  ): Promise<SettingRecord> {
    const existing = await this.get(key)

    let result
    if (existing) {
      const [updated] = await db
        .update(settings)
        .set({
          value,
          description: description ?? existing.description,
          modifiedAt: new Date(),
          modifiedBy: userId,
        })
        .where(eq(settings.key, key))
        .returning()
      result = updated
    } else {
      const [inserted] = await db
        .insert(settings)
        .values({
          key,
          value,
          description,
          modifiedBy: userId,
        })
        .returning()
      result = inserted
    }

    return result as SettingRecord
  }

  /**
   * Set a JSON value setting (upsert)
   */
  static async setJsonValue<T>(
    key: string,
    jsonValue: T,
    userId: string,
    description?: string,
  ): Promise<SettingRecord> {
    const existing = await this.get(key)

    let result
    if (existing) {
      const [updated] = await db
        .update(settings)
        .set({
          jsonValue,
          description: description ?? existing.description,
          modifiedAt: new Date(),
          modifiedBy: userId,
        })
        .where(eq(settings.key, key))
        .returning()
      result = updated
    } else {
      const [inserted] = await db
        .insert(settings)
        .values({
          key,
          jsonValue,
          description,
          modifiedBy: userId,
        })
        .returning()
      result = inserted
    }

    return result as SettingRecord
  }

  /**
   * Delete a setting
   */
  static async delete(key: string): Promise<boolean> {
    const result = await db
      .delete(settings)
      .where(eq(settings.key, key))
      .returning()
    return result.length > 0
  }
}
