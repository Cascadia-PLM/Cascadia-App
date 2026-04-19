import { forwardRef, useImperativeHandle, useState } from 'react'

export interface AnimatedGearBackgroundRef {
  speedUp: () => void
}

export const AnimatedGearBackground = forwardRef<AnimatedGearBackgroundRef>(
  (_, ref) => {
    const [isSpeedingUp, setIsSpeedingUp] = useState(false)

    useImperativeHandle(ref, () => ({
      speedUp: () => {
        setIsSpeedingUp(true)
      },
    }))

    // SVG path for a gear with proper flat-topped teeth
    const createGearPath = (
      centerX: number,
      centerY: number,
      outerRadius: number,
      innerRadius: number,
      teeth: number,
    ) => {
      const anglePerTooth = (2 * Math.PI) / teeth
      const toothTopWidth = anglePerTooth * 0.45 // Width of flat top of tooth
      const toothBaseWidth = anglePerTooth * 0.55 // Width at base of tooth

      let path = ''

      for (let i = 0; i < teeth; i++) {
        const toothCenter = i * anglePerTooth
        const nextToothCenter = (i + 1) * anglePerTooth

        // Tooth top corners (outer radius - flat top)
        const outerLeft = toothCenter - toothTopWidth / 2
        const outerRight = toothCenter + toothTopWidth / 2

        // Tooth base corners (inner radius)
        const baseLeft = toothCenter - toothBaseWidth / 2
        const baseRight = toothCenter + toothBaseWidth / 2

        // Next tooth base left (for the valley)
        const nextBaseLeft = nextToothCenter - toothBaseWidth / 2

        // Calculate all points
        const baseLeftX = centerX + Math.cos(baseLeft) * innerRadius
        const baseLeftY = centerY + Math.sin(baseLeft) * innerRadius
        const topLeftX = centerX + Math.cos(outerLeft) * outerRadius
        const topLeftY = centerY + Math.sin(outerLeft) * outerRadius
        const topRightX = centerX + Math.cos(outerRight) * outerRadius
        const topRightY = centerY + Math.sin(outerRight) * outerRadius
        const baseRightX = centerX + Math.cos(baseRight) * innerRadius
        const baseRightY = centerY + Math.sin(baseRight) * innerRadius
        const nextBaseLeftX = centerX + Math.cos(nextBaseLeft) * innerRadius
        const nextBaseLeftY = centerY + Math.sin(nextBaseLeft) * innerRadius

        if (i === 0) {
          path += `M ${baseLeftX} ${baseLeftY} `
        }

        // Draw tooth: base left -> top left -> top right -> base right
        path += `L ${topLeftX} ${topLeftY} L ${topRightX} ${topRightY} L ${baseRightX} ${baseRightY} `
        // Draw valley arc to next tooth's base left
        path += `A ${innerRadius} ${innerRadius} 0 0 1 ${nextBaseLeftX} ${nextBaseLeftY} `
      }

      path += 'Z'
      return path
    }

    return (
      <div className="fixed inset-0 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        {/* Animated gears */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            {/* Gradient for gears */}
            <linearGradient
              id="gearGradient"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.3" />
            </linearGradient>

            {/* Glow filter */}
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Left gear - rotates clockwise */}
          <g
            className={`transition-all origin-center ${
              isSpeedingUp ? 'animate-gear-fast-cw' : 'animate-gear-slow-cw'
            }`}
            style={{ transformOrigin: '720px 540px' }}
          >
            <circle
              cx="720"
              cy="540"
              r="80"
              fill="none"
              stroke="url(#gearGradient)"
              strokeWidth="3"
              filter="url(#glow)"
            />
            <path
              d={createGearPath(720, 540, 180, 140, 12)}
              fill="none"
              stroke="url(#gearGradient)"
              strokeWidth="4"
              filter="url(#glow)"
            />
          </g>

          {/* Right gear - rotates counter-clockwise, positioned to mesh */}
          <g
            className={`transition-all origin-center ${
              isSpeedingUp ? 'animate-gear-fast-ccw' : 'animate-gear-slow-ccw'
            }`}
            style={{ transformOrigin: '1200px 540px' }}
          >
            <circle
              cx="1200"
              cy="540"
              r="80"
              fill="none"
              stroke="url(#gearGradient)"
              strokeWidth="3"
              filter="url(#glow)"
            />
            <path
              d={createGearPath(1200, 540, 180, 140, 12)}
              fill="none"
              stroke="url(#gearGradient)"
              strokeWidth="4"
              filter="url(#glow)"
            />
          </g>

          {/* Decorative smaller gears in background */}
          <g
            className={
              isSpeedingUp ? 'animate-gear-fast-ccw' : 'animate-gear-slow-ccw'
            }
            style={{ transformOrigin: '300px 200px' }}
            opacity="0.15"
          >
            <path
              d={createGearPath(300, 200, 100, 75, 10)}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2"
            />
          </g>

          <g
            className={
              isSpeedingUp ? 'animate-gear-fast-cw' : 'animate-gear-slow-cw'
            }
            style={{ transformOrigin: '1620px 880px' }}
            opacity="0.15"
          >
            <path
              d={createGearPath(1620, 880, 120, 90, 10)}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2"
            />
          </g>
        </svg>
      </div>
    )
  },
)

AnimatedGearBackground.displayName = 'AnimatedGearBackground'
