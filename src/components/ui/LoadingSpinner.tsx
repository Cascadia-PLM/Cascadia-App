import { cn } from '@/lib/utils'

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
  label?: string
}

export function LoadingSpinner({
  size = 'md',
  className,
  label,
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-12 h-12',
    lg: 'w-16 h-16',
  }

  const gearSizes = {
    sm: { outer: 12, inner: 9, teeth: 8 },
    md: { outer: 18, inner: 13.5, teeth: 10 },
    lg: { outer: 24, inner: 18, teeth: 12 },
  }

  const gear = gearSizes[size]

  // Generate a proper gear path with flat-topped teeth
  const createGearPath = (
    outerRadius: number,
    innerRadius: number,
    teeth: number,
  ) => {
    const anglePerTooth = (2 * Math.PI) / teeth
    const toothTopWidth = anglePerTooth * 0.25 // Width of flat top of tooth
    const toothBaseWidth = anglePerTooth * 0.35 // Width at base of tooth
    const valleyWidth = anglePerTooth * 0.5 // Width of valley between teeth
    let path = ''

    for (let i = 0; i < teeth; i++) {
      const toothCenter = i * anglePerTooth

      // Tooth corners (outer radius - flat top)
      const outerLeft = toothCenter - toothTopWidth / 2
      const outerRight = toothCenter + toothTopWidth / 2

      // Tooth base corners (inner radius)
      const innerLeft = toothCenter - toothBaseWidth / 2
      const innerRight = toothCenter + toothBaseWidth / 2

      // Valley position (between this tooth and next)
      const valleyRight = toothCenter + anglePerTooth / 2 + valleyWidth / 2

      // Calculate points
      const p1x = 24 + Math.cos(innerLeft) * innerRadius // Base left
      const p1y = 24 + Math.sin(innerLeft) * innerRadius
      const p2x = 24 + Math.cos(outerLeft) * outerRadius // Top left
      const p2y = 24 + Math.sin(outerLeft) * outerRadius
      const p3x = 24 + Math.cos(outerRight) * outerRadius // Top right
      const p3y = 24 + Math.sin(outerRight) * outerRadius
      const p4x = 24 + Math.cos(innerRight) * innerRadius // Base right
      const p4y = 24 + Math.sin(innerRight) * innerRadius
      const p6x = 24 + Math.cos(valleyRight) * innerRadius // Valley end
      const p6y = 24 + Math.sin(valleyRight) * innerRadius

      if (i === 0) {
        path += `M ${p1x} ${p1y} `
      }

      // Draw tooth: up to top left, across flat top, down to base right
      path += `L ${p2x} ${p2y} L ${p3x} ${p3y} L ${p4x} ${p4y} `
      // Draw valley arc to next tooth
      path += `A ${innerRadius} ${innerRadius} 0 0 1 ${p6x} ${p6y} `
    }

    path += 'Z'
    return path
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3',
        className,
      )}
      role="status"
      aria-label={label || 'Loading'}
    >
      <svg
        className={cn('animate-spin-smooth', sizeClasses[size])}
        viewBox="0 0 48 48"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="spinnerGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity="1" />
          </linearGradient>
        </defs>

        {/* Center circle */}
        <circle
          cx="24"
          cy="24"
          r="6"
          fill="none"
          stroke="url(#spinnerGradient)"
          strokeWidth="2"
        />

        {/* Gear teeth */}
        <path
          d={createGearPath(gear.outer, gear.inner, gear.teeth)}
          fill="none"
          stroke="url(#spinnerGradient)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {label && <p className="text-sm text-gray-600 animate-pulse">{label}</p>}
    </div>
  )
}
