/**
 * Mechanism Template Parameter Schemas & Validation
 *
 * Provides early validation for mechanism template parameters
 * during BOM tool calls, before CAD generation dispatch.
 */

interface MechanismSchema {
  required: Array<string>
  optional: Array<string>
  roles: Array<string>
  /** Custom validation returning an error message or null if valid. */
  validate: (params: Record<string, number>) => string | null
}

export const MECHANISM_SCHEMAS: Record<string, MechanismSchema> = {
  rack_and_pinion: {
    required: [
      'module',
      'rack_length',
      'rack_height',
      'rack_thickness',
      'pinion_teeth',
      'pinion_face_width',
    ],
    optional: [
      'pressure_angle',
      'pinion_bore_diameter',
      'pinion_hub_diameter',
      'pinion_hub_length',
    ],
    roles: ['rack', 'pinion'],
    validate: (params) => {
      if (params.pinion_teeth < 6) {
        return 'pinion_teeth must be >= 6 to avoid undercut'
      }
      if (params.pinion_teeth % 1 !== 0) {
        return 'pinion_teeth must be an integer'
      }
      const pressureAngle = params.pressure_angle
      if (
        pressureAngle !== undefined &&
        (pressureAngle < 14.5 || pressureAngle > 25)
      ) {
        return 'pressure_angle must be between 14.5 and 25 degrees'
      }
      if (
        params.pinion_hub_diameter !== undefined &&
        params.pinion_bore_diameter !== undefined &&
        params.pinion_hub_diameter <= params.pinion_bore_diameter
      ) {
        return 'pinion_hub_diameter must be larger than pinion_bore_diameter'
      }
      return null
    },
  },
}

/**
 * Validate mechanism parameters early (in BOM tool call).
 * Returns `{ valid: true }` or `{ valid: false, error: string }`.
 */
export function validateMechanismParameters(
  mechanismType: string,
  parameters: Record<string, number>,
): { valid: boolean; error?: string } {
  const schema = MECHANISM_SCHEMAS[mechanismType]
  if (!schema) {
    return {
      valid: false,
      error: `Unknown mechanism type: ${mechanismType}. Available: ${Object.keys(MECHANISM_SCHEMAS).join(', ')}`,
    }
  }

  // Check required parameters
  const missing = schema.required.filter((p) => parameters[p] === undefined)
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required parameters for ${mechanismType}: ${missing.join(', ')}`,
    }
  }

  // Check all parameters are known
  const allKnown = new Set([...schema.required, ...schema.optional])
  const unknown = Object.keys(parameters).filter((p) => !allKnown.has(p))
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `Unknown parameters for ${mechanismType}: ${unknown.join(', ')}`,
    }
  }

  // Check all values are positive numbers
  for (const [key, val] of Object.entries(parameters)) {
    if (typeof val !== 'number' || !isFinite(val) || val <= 0) {
      return {
        valid: false,
        error: `Parameter '${key}' must be a positive number, got ${val}`,
      }
    }
  }

  // Run type-specific validation
  const customError = schema.validate(parameters)
  if (customError) {
    return { valid: false, error: customError }
  }

  return { valid: true }
}

/**
 * Get the expected output roles for a mechanism type.
 */
export function getMechanismRoles(mechanismType: string): Array<string> | undefined {
  return MECHANISM_SCHEMAS[mechanismType]?.roles
}

/**
 * Compute preview metadata from mechanism parameters (for immediate LLM feedback).
 */
export function computeMechanismPreview(
  mechanismType: string,
  parameters: Record<string, number>,
): Record<string, unknown> {
  if (mechanismType === 'rack_and_pinion') {
    const mod = parameters.module
    const teeth = parameters.pinion_teeth
    const pitchDiameter = mod * teeth
    const toothPitch = mod * Math.PI
    const rackToothCount = Math.ceil(parameters.rack_length / toothPitch)
    const addendum = mod
    const dedendum = 1.25 * mod
    return {
      pitchDiameterMm: Math.round(pitchDiameter * 100) / 100,
      toothPitchMm: Math.round(toothPitch * 100) / 100,
      rackToothCount,
      addendumMm: addendum,
      dedendumMm: dedendum,
      linearTravelPerRevolutionMm:
        Math.round(pitchDiameter * Math.PI * 100) / 100,
    }
  }
  return {}
}
