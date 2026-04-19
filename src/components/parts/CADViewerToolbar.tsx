import {
  Box,
  Download,
  Grid3x3,
  Maximize2,
  Minimize2,
  Paintbrush,
  RotateCcw,
  Sun,
} from 'lucide-react'
import { BACKGROUND_PRESETS, MATERIAL_PRESETS } from './CADViewerTypes'
import type { BackgroundPreset, MaterialPreset } from './CADViewerTypes'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui'

interface CADViewerToolbarProps {
  wireframe: boolean
  showGrid: boolean
  isFullscreen: boolean
  backgroundPreset: BackgroundPreset
  materialPreset: MaterialPreset
  polygonCount?: number
  /** Whether the loaded model has embedded colors (e.g. glTF with per-material colors) */
  hasEmbeddedColors?: boolean
  onResetView: () => void
  onToggleWireframe: () => void
  onToggleGrid: () => void
  onToggleFullscreen: () => void
  onBackgroundChange: (preset: BackgroundPreset) => void
  onMaterialChange: (preset: MaterialPreset) => void
  onDownload?: () => void
}

function ToolbarButton({
  tooltip,
  active,
  onClick,
  children,
}: {
  tooltip: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'default' : 'ghost'}
          size="icon"
          className="h-7 w-7"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-slate-300 dark:bg-slate-600 mx-1" />
}

export function CADViewerToolbar({
  wireframe,
  showGrid,
  isFullscreen,
  backgroundPreset,
  materialPreset,
  polygonCount,
  hasEmbeddedColors = false,
  onResetView,
  onToggleWireframe,
  onToggleGrid,
  onToggleFullscreen,
  onBackgroundChange,
  onMaterialChange,
  onDownload,
}: CADViewerToolbarProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm rounded-lg shadow-lg px-2 py-1.5 border border-slate-200 dark:border-slate-700">
        {/* View Group */}
        <ToolbarButton tooltip="Reset View (R)" onClick={onResetView}>
          <RotateCcw className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          tooltip="Wireframe (W)"
          active={wireframe}
          onClick={onToggleWireframe}
        >
          <Grid3x3 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          tooltip="Grid (G)"
          active={showGrid}
          onClick={onToggleGrid}
        >
          <Box className="h-3.5 w-3.5" />
        </ToolbarButton>

        <ToolbarDivider />

        {/* Display Group */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Sun className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Background
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Background</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={backgroundPreset}
              onValueChange={(v) => onBackgroundChange(v as BackgroundPreset)}
            >
              {(
                Object.entries(BACKGROUND_PRESETS) as Array<
                  [
                    BackgroundPreset,
                    (typeof BACKGROUND_PRESETS)[BackgroundPreset],
                  ]
                >
              ).map(([key, config]) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {config.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Paintbrush className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Material
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Material</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={materialPreset}
              onValueChange={(v) => onMaterialChange(v as MaterialPreset)}
            >
              {(
                Object.entries(MATERIAL_PRESETS) as Array<
                  [MaterialPreset, (typeof MATERIAL_PRESETS)[MaterialPreset]]
                >
              ).map(([key, config]) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  <span
                    className="inline-block w-3 h-3 rounded-full mr-2 border border-slate-300 dark:border-slate-600"
                    style={{
                      backgroundColor:
                        key === 'default' && hasEmbeddedColors
                          ? undefined
                          : config.color,
                    }}
                    {...(key === 'default' && hasEmbeddedColors
                      ? {
                          className:
                            'inline-block w-3 h-3 rounded-full mr-2 border border-slate-300 dark:border-slate-600 bg-gradient-to-br from-red-400 via-green-400 to-blue-400',
                        }
                      : {})}
                  />
                  {key === 'default' && hasEmbeddedColors
                    ? 'Original Colors'
                    : config.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarDivider />

        {/* Actions Group */}
        {onDownload && (
          <ToolbarButton tooltip="Download" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" />
          </ToolbarButton>
        )}
        <ToolbarButton
          tooltip={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
          active={isFullscreen}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </ToolbarButton>

        {/* Stats */}
        {polygonCount != null && (
          <>
            <ToolbarDivider />
            <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums px-1">
              {polygonCount >= 1000
                ? `${(polygonCount / 1000).toFixed(1)}k`
                : polygonCount}{' '}
              tris
            </span>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
