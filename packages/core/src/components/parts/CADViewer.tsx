// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  Suspense,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  GizmoHelper,
  GizmoViewcube,
  Grid,
  PerspectiveCamera,
  TrackballControls,
} from '@react-three/drei'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Loader2 } from 'lucide-react'
import { BACKGROUND_PRESETS, MATERIAL_PRESETS } from './CADViewerTypes'
import type {
  BackgroundPreset,
  MaterialPreset,
  StandardView,
} from './CADViewerTypes'

export interface CADViewerHandle {
  /** Reset the camera to fit the model in view */
  resetView: () => void
  /** Snap camera to a standard view */
  setView: (view: StandardView) => void
}

/** What a loaded model reports back about itself. */
export interface CADModelStats {
  /** Triangle count across every mesh in the model */
  polygonCount: number
  /** Size of the model's bounding box (x/y/z extents) */
  boundingBox: THREE.Vector3
  /**
   * Center of that bounding box, in the model's native part coordinates.
   * Geometry is never recentered, so a part authored away from its origin
   * sits away from the world origin here too, and this is what the camera
   * has to aim at to frame it.
   */
  boundingBoxCenter: THREE.Vector3
}

/** The volume the camera frames: a model's extents and where they sit. */
interface ModelBounds {
  size: THREE.Vector3
  center: THREE.Vector3
}

/** Which side of a comparison a model occupies. */
export type CADCompareSlot = 'A' | 'B'

/**
 * One model in a comparison, with the tint it is drawn in.
 *
 * A comparison is symmetric: neither side is "the model" and the other "the
 * overlay". Both name a file explicitly, so each side can come from any
 * version of the part — released revision, historical revision, or an
 * in-work ECO/workspace branch — and each carries its own color, opacity and
 * visibility.
 */
export interface CADCompareLayer {
  /** Vault file id of the model this layer draws. */
  fileId: string
  /** URL to fetch it from */
  fileUrl: string
  /** File type/extension (stl, obj, glb, gltf) */
  fileType: string
  /** File name, for the legend */
  fileName: string
  /** Which version this file came from, for the legend */
  versionLabel: string
  /** Tint applied to every surface of this layer */
  color: string
  /** Layer opacity, 0..1 */
  opacity: number
  /** Whether this layer is rendered at all */
  visible: boolean
}

/** The two sides of a comparison; either may be unset while being picked. */
export interface CADComparison {
  a: CADCompareLayer | null
  b: CADCompareLayer | null
}

/**
 * Default tints for the two sides. Distinct in hue and in lightness, so the
 * pair still reads apart for the ~8% of men with red-green color vision
 * deficiency, and against both viewer backgrounds.
 */
export const COMPARE_SLOT_COLORS: Record<CADCompareSlot, string> = {
  A: '#3b82f6',
  B: '#f97316',
}

/** Opacity a comparison layer starts at — translucent enough to see through. */
export const DEFAULT_COMPARE_OPACITY = 0.6

interface CADViewerProps {
  /** URL to the CAD file to display */
  fileUrl: string
  /** File type/extension (stl, obj, etc.) */
  fileType: string
  /** Optional file name for display */
  fileName?: string
  /** Whether to show wireframe mode */
  wireframe?: boolean
  /** Whether to show grid */
  showGrid?: boolean
  /** Background preset */
  backgroundPreset?: BackgroundPreset
  /** Material preset */
  materialPreset?: MaterialPreset
  /** Whether the file has embedded colors (e.g. glTF with per-material colors) */
  hasEmbeddedColors?: boolean
  /**
   * Two models overlaid for version comparison, replacing the single model
   * named by `fileUrl` while set. Both render in their native part
   * coordinates, so two versions of the same part align without any
   * registration step, and each is tinted per its own layer so differences
   * read as distinct colors.
   */
  comparison?: CADComparison | null
  /** Loading callback — fires for the model on side A */
  onLoad?: (stats: CADModelStats) => void
  /** Error callback — fires for the model on side A */
  onError?: (error: Error) => void
  /** A comparison layer failed to load (the other side keeps rendering) */
  onComparisonError?: (error: Error) => void
}

/** What one side of the viewer is doing right now. */
interface SlotState {
  status: 'idle' | 'loading' | 'loaded' | 'failed'
  bounds: ModelBounds | null
  message: string | null
}

const IDLE_SLOT: SlotState = { status: 'idle', bounds: null, message: null }
const LOADING_SLOT: SlotState = {
  status: 'loading',
  bounds: null,
  message: null,
}

/** A model to draw, resolved from either the single-model or compare props. */
interface RenderLayer {
  slot: CADCompareSlot
  fileUrl: string
  fileType: string
  fileName: string
  /** Legend caption naming the version, empty outside comparison */
  versionLabel: string
  hasEmbeddedColors: boolean
  tint: { color: string; opacity: number } | null
  visible: boolean
}

/**
 * 3D CAD Model Viewer Component
 * Supports STL and OBJ file formats with trackball controls
 * (full, unconstrained rotation for model interrogation)
 */
export const CADViewer = forwardRef<CADViewerHandle, CADViewerProps>(
  function CADViewer(
    {
      fileUrl,
      fileType,
      fileName,
      wireframe = false,
      showGrid = false,
      backgroundPreset = 'dark',
      materialPreset = 'default',
      hasEmbeddedColors = false,
      comparison = null,
      onLoad,
      onError,
      onComparisonError,
    },
    ref,
  ) {
    const [slotA, setSlotA] = useState<SlotState>(LOADING_SLOT)
    const [slotB, setSlotB] = useState<SlotState>(IDLE_SLOT)
    const controlsRef = useRef<any>(null)
    const cameraRef = useRef<THREE.PerspectiveCamera>(null)

    const isComparing = comparison !== null

    // Both sides of a comparison are ordinary layers; outside one, the single
    // model occupies side A. Keeping it on the same slot is what lets the
    // loaded geometry survive opening the compare panel: the <Model> keeps
    // its key and its file URL, so nothing reloads.
    const layers: Array<RenderLayer> = []
    if (comparison) {
      const sides: Array<[CADCompareSlot, CADCompareLayer | null]> = [
        ['A', comparison.a],
        ['B', comparison.b],
      ]
      for (const [slot, layer] of sides) {
        if (!layer) continue
        layers.push({
          slot,
          fileUrl: layer.fileUrl,
          fileType: layer.fileType,
          fileName: layer.fileName,
          versionLabel: layer.versionLabel,
          // The tint replaces every material anyway, embedded colors included
          hasEmbeddedColors: false,
          tint: { color: layer.color, opacity: layer.opacity },
          visible: layer.visible,
        })
      }
    } else {
      layers.push({
        slot: 'A',
        fileUrl,
        fileType,
        fileName: fileName ?? '',
        versionLabel: '',
        hasEmbeddedColors,
        tint: null,
        visible: true,
      })
    }

    const layerA = layers.find((l) => l.slot === 'A') ?? null
    const layerB = layers.find((l) => l.slot === 'B') ?? null
    const urlA = layerA?.fileUrl ?? null
    const urlB = layerB?.fileUrl ?? null

    // A new file on a side starts that side's own load cycle
    useEffect(() => {
      setSlotA(urlA === null ? IDLE_SLOT : LOADING_SLOT)
    }, [urlA])
    useEffect(() => {
      setSlotB(urlB === null ? IDLE_SLOT : LOADING_SLOT)
    }, [urlB])

    // What the camera frames: every loaded layer at once, so no model can sit
    // outside the view. Memoized because its identity re-triggers the
    // auto-fit — and deliberately independent of visibility, so hiding a side
    // does not yank the camera.
    const boundsA = slotA.bounds
    const boundsB = slotB.bounds
    const modelBounds = useMemo(
      () => unionBounds(boundsA, boundsB),
      [boundsA, boundsB],
    )

    // Set camera to a standard view
    const setView = (view: StandardView) => {
      if (!cameraRef.current || !modelBounds) return
      applyStandardView(
        cameraRef.current,
        controlsRef.current,
        modelBounds,
        view,
      )
    }

    // Reset camera view to fit model
    const resetView = () => {
      setView('iso')
    }

    // Expose resetView and setView via ref
    useImperativeHandle(
      ref,
      () => ({
        resetView,
        setView,
      }),
      [modelBounds],
    )

    const setSlot = (slot: CADCompareSlot, state: SlotState) => {
      if (slot === 'A') setSlotA(state)
      else setSlotB(state)
    }

    const handleLayerLoad = (slot: CADCompareSlot, stats: CADModelStats) => {
      setSlot(slot, {
        status: 'loaded',
        bounds: boundsFromStats(stats),
        message: null,
      })
      // Side A is the model the toolbar reports on, comparing or not
      if (slot === 'A') onLoad?.(stats)
    }

    const handleLayerError = (
      slot: CADCompareSlot,
      layer: RenderLayer,
      err: Error,
    ) => {
      setSlot(slot, {
        status: 'failed',
        bounds: null,
        message: `Failed to load ${layer.fileType.toUpperCase()} file: ${err.message}`,
      })
      // One callback per failure: a comparison layer failing is a comparison
      // problem even when it is side A, and reporting it as both produces two
      // toasts for one dead model.
      if (isComparing) onComparisonError?.(err)
      else onError?.(err)
    }

    // Outside a comparison there is nothing else on screen, so a failed load
    // takes the whole viewer. While comparing it must not: one side failing
    // leaves the other side worth looking at, and the legend says which died.
    if (!isComparing && slotA.status === 'failed') {
      return (
        <div className="flex items-center justify-center h-full bg-slate-100 dark:bg-slate-800 rounded-lg">
          <div className="text-center p-8">
            <p className="text-red-500 dark:text-red-400 font-medium mb-2">
              Error Loading Model
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {slotA.message}
            </p>
          </div>
        </div>
      )
    }

    // Calculate dynamic zoom limits based on model size
    const size = modelBounds?.size
    const maxDim = size ? Math.max(size.x, size.y, size.z) : 100
    const minZoomDistance = Math.max(0.1, maxDim * 0.01)
    const maxZoomDistance = Math.max(1000, maxDim * 10)
    const initialCameraDistance = size ? getOptimalCameraDistance(size) : 5

    // Depth-buffer precision. A perspective depth buffer resolves surfaces
    // only down to distance^2 / (near * 2^24), so a fixed tiny near plane is
    // what makes near-coincident CAD faces z-fight: at near = 0.01 a 1200 mm
    // assembly viewed from its fit distance could not separate two surfaces
    // less than ~22 mm apart, and every plate sitting on a frame speckled.
    // The error grows as the square of model size, which is why small parts
    // always looked clean and assemblies did not. Scaling near with the model
    // brings that same case to ~0.2 mm. Nothing reachable is clipped:
    // TrackballControls already stops zooming in at maxDim * 0.01 below.
    // The second term only binds for sub-millimetre models, where the 1000
    // floor under maxZoomDistance would otherwise stretch the ratio again.
    const cameraFar = maxZoomDistance + maxDim
    const cameraNear = Math.max(maxDim / 1000, cameraFar / 1e6)

    const bgConfig = BACKGROUND_PRESETS[backgroundPreset]

    // Calculate grid cell size based on model bounds
    const gridCellSize = size
      ? Math.pow(10, Math.floor(Math.log10(maxDim / 5)))
      : 1

    // Ground plane for the grid and contact shadows — just below the model,
    // which sits wherever its native coordinates put it rather than at the
    // origin, so this is measured down from the bounding-box center.
    const groundY = modelBounds
      ? modelBounds.center.y - modelBounds.size.y / 2 - 0.01
      : 0

    const slotState = (slot: CADCompareSlot) => (slot === 'A' ? slotA : slotB)
    // The blocking spinner belongs to the first paint only. While comparing,
    // a side still loading gets a pill instead, so the side that is ready
    // stays on screen.
    const showBlockingSpinner = !isComparing && slotA.status === 'loading'
    const pendingLayers = layers.filter(
      (l) => slotState(l.slot).status === 'loading',
    )
    const failedLayers = layers.filter(
      (l) => slotState(l.slot).status === 'failed',
    )

    return (
      <div className="relative w-full h-full rounded-lg overflow-hidden">
        {showBlockingSpinner && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-slate-50/80 dark:bg-slate-900/80 backdrop-blur-sm">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500 mx-auto mb-2" />
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Loading {fileType.toUpperCase()} model...
              </p>
            </div>
          </div>
        )}

        <Canvas shadows>
          <PerspectiveCamera
            ref={cameraRef}
            makeDefault
            position={[0, 0, initialCameraDistance]}
            fov={50}
            near={cameraNear}
            far={cameraFar}
          />

          {/* Scene Background */}
          <SceneBackground
            topColor={bgConfig.topColor}
            bottomColor={bgConfig.bottomColor}
          />

          {/* Lighting */}
          <ambientLight intensity={0.5} />
          <ModelShadowLight bounds={modelBounds} />
          <directionalLight position={[-10, -10, -5]} intensity={0.3} />

          {/* Environment for reflections */}
          <Suspense fallback={null}>
            <Environment preset={bgConfig.environmentPreset as any} />
          </Suspense>

          {/* Models. Geometry is deliberately never recentered: every layer
              renders in the part's native coordinates, which is exactly what
              lets two versions overlay and align without a registration step.
              The camera aims at the union of their bounding boxes instead —
              see CameraAutoFit. Keyed by slot, not by URL, so changing which
              file a side shows reloads that side in place. */}
          <Suspense fallback={null}>
            {layers.map((layer) => (
              <Model
                key={layer.slot}
                fileUrl={layer.fileUrl}
                fileType={layer.fileType}
                wireframe={wireframe}
                materialPreset={materialPreset}
                hasEmbeddedColors={layer.hasEmbeddedColors}
                tint={layer.tint}
                visible={layer.visible}
                renderOrder={layer.slot === 'A' ? 0 : 1}
                onLoad={(stats) => handleLayerLoad(layer.slot, stats)}
                onError={(err) => handleLayerError(layer.slot, layer, err)}
              />
            ))}
          </Suspense>

          {/* Grid */}
          {showGrid && (
            <Grid
              position={[0, groundY, 0]}
              args={[100, 100]}
              cellSize={gridCellSize}
              cellThickness={0.5}
              cellColor="#94a3b8"
              sectionSize={gridCellSize * 10}
              sectionThickness={1}
              sectionColor="#64748b"
              fadeDistance={maxDim * 5}
              fadeStrength={1}
              infiniteGrid
            />
          )}

          {/* Contact shadows for studio mode */}
          {bgConfig.contactShadows && modelBounds && (
            <ContactShadows
              position={[modelBounds.center.x, groundY, modelBounds.center.z]}
              opacity={0.4}
              scale={maxDim * 3}
              blur={2}
              far={maxDim * 2}
              frames={1}
            />
          )}

          {/* Orientation Gizmo */}
          <GizmoHelper alignment="top-right" margin={[72, 72]}>
            <GizmoViewcube
              color="#64748b"
              hoverColor="#06b6d4"
              textColor="white"
              strokeColor="#475569"
            />
          </GizmoHelper>

          {/* Trackball controls: unlimited tumbling (no polar-angle clamp
              like OrbitControls), so models can be rotated freely for
              inspection from any direction. Dynamic zoom limits. */}
          <TrackballControls
            ref={controlsRef}
            makeDefault
            rotateSpeed={2.5}
            zoomSpeed={1.0}
            panSpeed={0.5}
            staticMoving={false}
            dynamicDampingFactor={0.15}
            minDistance={minZoomDistance}
            maxDistance={maxZoomDistance}
          />

          {/* Auto-fit camera when model loads */}
          {modelBounds && (
            <CameraAutoFit bounds={modelBounds} controlsRef={controlsRef} />
          )}
        </Canvas>

        {/* File name overlay; a color legend while comparing */}
        {isComparing ? (
          <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg space-y-1 max-w-[min(20rem,calc(100%-2rem))]">
            {layers.map((layer) => (
              <div key={layer.slot} className="flex items-start gap-2">
                <span
                  className="mt-1 inline-block h-2.5 w-2.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: layer.tint?.color,
                    opacity: layer.visible ? 1 : 0.3,
                  }}
                />
                <div className="min-w-0">
                  <p
                    className={`text-xs font-medium truncate ${
                      layer.visible
                        ? 'text-slate-700 dark:text-slate-300'
                        : 'text-slate-400 dark:text-slate-500 line-through'
                    }`}
                  >
                    {layer.versionLabel}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {slotState(layer.slot).status === 'failed'
                      ? 'Failed to load'
                      : layer.fileName}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          fileName &&
          !showBlockingSpinner && (
            <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {fileName}
              </p>
            </div>
          )
        )}

        {/* Per-layer load status — bottom center, clear of the legend
            (bottom-left) and the compare panel (bottom-right) */}
        {isComparing && pendingLayers.length > 0 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Loading {pendingLayers.map((l) => l.slot).join(' and ')}…
            </p>
          </div>
        )}
        {isComparing &&
          pendingLayers.length === 0 &&
          failedLayers.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg">
              <p className="text-xs font-medium text-red-500 dark:text-red-400">
                {failedLayers.length === 1
                  ? `Side ${failedLayers[0]?.slot} failed to load`
                  : 'Both models failed to load'}
              </p>
            </div>
          )}
      </div>
    )
  },
)

/**
 * Sets the scene background to a vertical gradient
 */
function SceneBackground({
  topColor,
  bottomColor,
}: {
  topColor: string
  bottomColor: string
}) {
  const { scene } = useThree()

  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 256
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, 0, 256)
    gradient.addColorStop(0, topColor)
    gradient.addColorStop(1, bottomColor)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 2, 256)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }, [topColor, bottomColor])

  useEffect(() => {
    scene.background = texture
    return () => {
      texture.dispose()
      scene.background = null
    }
  }, [scene, texture])

  return null
}

/** The volume a freshly loaded model occupies, in its native coordinates. */
function boundsFromStats(stats: CADModelStats): ModelBounds {
  return { size: stats.boundingBox, center: stats.boundingBoxCenter }
}

/**
 * Smallest volume containing both models, for framing a comparison. Two
 * versions of a part share native coordinates but not extents — a boss added
 * in the newer revision pushes one box past the other. Null until at least
 * one side has loaded; a single loaded side frames itself.
 */
function unionBounds(
  first: ModelBounds | null,
  second: ModelBounds | null,
): ModelBounds | null {
  if (!first) return second
  if (!second) return first

  const box = new THREE.Box3().setFromCenterAndSize(first.center, first.size)
  box.union(new THREE.Box3().setFromCenterAndSize(second.center, second.size))

  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  return { size, center }
}

/** Calculate optimal camera distance based on model size */
function getOptimalCameraDistance(size: THREE.Vector3): number {
  const maxDimension = Math.max(size.x, size.y, size.z)
  // Use FOV to calculate distance that fits the model with some padding
  const fov = 50 * (Math.PI / 180) // Convert to radians
  const distance = maxDimension / 2 / Math.tan(fov / 2)
  return distance * 1.5 // Add 50% padding for comfortable viewing
}

/** Where the camera sits relative to the model, and which way is up, per view */
function getViewPlacement(
  view: StandardView,
  distance: number,
): { offset: THREE.Vector3; up: THREE.Vector3 } {
  const yUp = new THREE.Vector3(0, 1, 0)

  switch (view) {
    case 'front':
      return { offset: new THREE.Vector3(0, 0, distance), up: yUp }
    case 'back':
      return { offset: new THREE.Vector3(0, 0, -distance), up: yUp }
    case 'left':
      return { offset: new THREE.Vector3(-distance, 0, 0), up: yUp }
    case 'right':
      return { offset: new THREE.Vector3(distance, 0, 0), up: yUp }
    case 'top':
      return {
        offset: new THREE.Vector3(0, distance, 0),
        up: new THREE.Vector3(0, 0, -1),
      }
    case 'bottom':
      return {
        offset: new THREE.Vector3(0, -distance, 0),
        up: new THREE.Vector3(0, 0, 1),
      }
    case 'iso':
      return {
        offset: new THREE.Vector3(distance * 0.5, distance * 0.3, distance),
        up: yUp,
      }
  }
}

/**
 * Frame a model from a standard direction.
 *
 * Every placement is relative to the model's bounding-box center, never the
 * world origin: geometry keeps its native part coordinates, so a part
 * authored far from its origin would otherwise sit outside the frame while
 * the camera stared at empty space.
 */
function applyStandardView(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update: () => void } | null,
  bounds: ModelBounds,
  view: StandardView,
) {
  const distance = getOptimalCameraDistance(bounds.size)
  const { offset, up } = getViewPlacement(view, distance)

  camera.up.copy(up)
  camera.position.copy(bounds.center).add(offset)
  camera.lookAt(bounds.center)

  if (controls) {
    controls.target.copy(bounds.center)
    controls.update()
  }
}

/** Unit direction the key light shines from, kept off the model's scale. */
const KEY_LIGHT_DIRECTION = new THREE.Vector3(10, 10, 5).normalize()

/**
 * Key light, with its shadow camera fitted to the model.
 *
 * three.js defaults a DirectionalLight's shadow camera to an orthographic box
 * of +/-5 units at near 0.5 / far 500, aimed at a `target` that starts at the
 * world origin and is not in the scene graph. Models here are millimetre-scale
 * and render in native part coordinates, so that frustum both was far too
 * small and pointed at empty space: every mesh sets castShadow/receiveShadow,
 * yet the 2048^2 shadow pass ran each frame over geometry it never covered.
 * Anything that did land inside it acned, because the default bias is zero.
 *
 * Only the light's direction affects shading, so moving it onto the model
 * changes nothing but the shadow frustum.
 */
function ModelShadowLight({ bounds }: { bounds: ModelBounds | null }) {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const { scene } = useThree()

  useEffect(() => {
    const light = lightRef.current
    if (!light || !bounds) return

    // Bounding-sphere radius: half the box diagonal, so the frustum covers
    // the model from whatever angle the light ends up on.
    const radius = bounds.size.length() / 2 || 1
    const distance = radius * 4

    light.position
      .copy(bounds.center)
      .addScaledVector(KEY_LIGHT_DIRECTION, distance)

    // The target is a bare Object3D that no one adds to the scene, so its
    // matrixWorld never updates and the shadow camera keeps looking at the
    // origin. Parent it so the renderer maintains it.
    light.target.position.copy(bounds.center)
    scene.add(light.target)

    const cam = light.shadow.camera
    cam.left = -radius
    cam.right = radius
    cam.top = radius
    cam.bottom = -radius
    cam.near = distance - radius
    cam.far = distance + radius
    cam.updateProjectionMatrix()

    // normalBias is in world units, so it has to scale with the model too:
    // a fixed value either does nothing at metre scale or opens visible gaps
    // where parts touch.
    light.shadow.normalBias = radius * 0.01

    return () => {
      scene.remove(light.target)
    }
  }, [bounds, scene])

  return (
    <directionalLight
      ref={lightRef}
      position={[10, 10, 5]}
      intensity={1}
      castShadow
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
    />
  )
}

/**
 * Component to auto-fit camera to model bounds whenever a model loads.
 * `bounds` is a fresh object per load, so switching CAD files re-frames.
 */
function CameraAutoFit({
  bounds,
  controlsRef,
}: {
  bounds: ModelBounds
  controlsRef: React.RefObject<any>
}) {
  const { camera } = useThree()

  useEffect(() => {
    applyStandardView(camera, controlsRef.current, bounds, 'iso')
  }, [bounds, camera, controlsRef])

  return null
}

/**
 * Internal Model component that loads and displays the 3D geometry.
 * Supports STL, OBJ, and glTF/GLB file formats.
 * For glTF files with embedded colors, supports switching between
 * original materials and preset overrides.
 *
 * A `tint` replaces every material with a flat translucent color — the
 * comparison overlay's rendering mode. Translucent tints skip depth writes
 * so two near-coincident shells blend instead of z-fighting; unchanged
 * regions read as the blend of both colors, differences as a single color.
 */
function Model({
  fileUrl,
  fileType,
  wireframe = false,
  materialPreset = 'default',
  hasEmbeddedColors = false,
  tint = null,
  visible = true,
  renderOrder = 0,
  onLoad,
  onError,
}: {
  fileUrl: string
  fileType: string
  wireframe?: boolean
  materialPreset?: MaterialPreset
  hasEmbeddedColors?: boolean
  tint?: { color: string; opacity: number } | null
  visible?: boolean
  renderOrder?: number
  onLoad: (stats: CADModelStats) => void
  onError: (error: Error) => void
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [gltfScene, setGltfScene] = useState<THREE.Group | null>(null)
  const originalMaterialsRef = useRef<
    Map<string, THREE.Material | Array<THREE.Material>>
  >(new Map())
  const disposablesRef = useRef<{
    geometry: THREE.BufferGeometry | null
    gltfScene: THREE.Group | null
  }>({ geometry: null, gltfScene: null })

  // Use refs for callbacks to avoid restarting the load when parent re-renders
  const onLoadRef = useRef(onLoad)
  const onErrorRef = useRef(onError)
  onLoadRef.current = onLoad
  onErrorRef.current = onError

  function disposeResources(resources: {
    geometry: THREE.BufferGeometry | null
    gltfScene: THREE.Group | null
  }) {
    if (resources.geometry) {
      resources.geometry.dispose()
    }
    if (resources.gltfScene) {
      resources.gltfScene.traverse((child) => {
        // Cast lies; runtime Three.js Object3D may or may not be a Mesh.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isMesh discriminates Mesh from generic Object3D at runtime
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh
          mesh.geometry.dispose()
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose())
          } else {
            mesh.material.dispose()
          }
        }
      })
    }
  }

  useEffect(() => {
    let cancelled = false

    const loadModel = async () => {
      try {
        // Dispose previous resources before loading new ones
        disposeResources(disposablesRef.current)
        disposablesRef.current = { geometry: null, gltfScene: null }

        const ext = fileType.toLowerCase()

        if (ext === 'glb' || ext === 'gltf') {
          // Load glTF/GLB file
          const loader = new GLTFLoader()
          const gltf = await new Promise<any>((resolve, reject) => {
            loader.load(
              fileUrl,
              (result) => resolve(result),
              undefined,
              (err) => reject(err),
            )
          })

          if (cancelled) return

          const scene = gltf.scene as THREE.Group

          // Cache original materials for restoring later
          const origMats = new Map<
            string,
            THREE.Material | Array<THREE.Material>
          >()
          scene.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
              origMats.set(
                child.uuid,
                Array.isArray(child.material)
                  ? child.material.map((m: THREE.Material) => m.clone())
                  : child.material.clone(),
              )
            }
          })
          originalMaterialsRef.current = origMats

          // Calculate stats from all meshes
          let totalPolygons = 0
          const box = new THREE.Box3()
          scene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              const geom = child.geometry
              if (geom) {
                totalPolygons += geom.index
                  ? geom.index.count / 3
                  : (geom.attributes.position?.count ?? 0) / 3
              }
              box.expandByObject(child)
            }
          })

          const size = new THREE.Vector3()
          const center = new THREE.Vector3()
          box.getSize(size)
          box.getCenter(center)

          disposablesRef.current = { geometry: null, gltfScene: scene }
          setGltfScene(scene)
          setGeometry(null) // Clear any previous geometry
          onLoadRef.current({
            polygonCount: Math.floor(totalPolygons),
            boundingBox: size,
            boundingBoxCenter: center,
          })
        } else {
          let loadedGeometry: THREE.BufferGeometry

          if (ext === 'stl') {
            const loader = new STLLoader()
            loadedGeometry = await new Promise<THREE.BufferGeometry>(
              (resolve, reject) => {
                loader.load(
                  fileUrl,
                  (geom) => resolve(geom),
                  undefined,
                  (err) => reject(err),
                )
              },
            )
          } else if (ext === 'obj') {
            const loader = new OBJLoader()
            const object = await new Promise<THREE.Group>((resolve, reject) => {
              loader.load(
                fileUrl,
                (obj) => resolve(obj),
                undefined,
                (err) => reject(err),
              )
            })

            const meshes: Array<THREE.BufferGeometry> = []
            object.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                meshes.push(child.geometry)
              }
            })

            const firstMesh = meshes[0]
            if (!firstMesh) {
              throw new Error('No geometry found in OBJ file')
            }

            loadedGeometry = firstMesh
          } else {
            throw new Error(`Unsupported file type: ${ext}`)
          }

          if (cancelled) return

          if (!('normal' in loadedGeometry.attributes)) {
            loadedGeometry.computeVertexNormals()
          }

          loadedGeometry.computeBoundingBox()
          const boundingBox = loadedGeometry.boundingBox
          const size = new THREE.Vector3()
          const center = new THREE.Vector3()
          if (boundingBox) {
            boundingBox.getSize(size)
            boundingBox.getCenter(center)
          }

          const polygonCount = loadedGeometry.index
            ? loadedGeometry.index.count / 3
            : (loadedGeometry.attributes.position?.count ?? 0) / 3

          disposablesRef.current = { geometry: loadedGeometry, gltfScene: null }
          setGeometry(loadedGeometry)
          setGltfScene(null) // Clear any previous glTF scene
          originalMaterialsRef.current.clear()
          onLoadRef.current({
            polygonCount: Math.floor(polygonCount),
            boundingBox: size,
            boundingBoxCenter: center,
          })
        }
      } catch (error) {
        if (!cancelled) {
          onErrorRef.current(
            error instanceof Error ? error : new Error(String(error)),
          )
        }
      }
    }

    loadModel()

    return () => {
      cancelled = true
      disposeResources(disposablesRef.current)
      disposablesRef.current = { geometry: null, gltfScene: null }
      // Dispose cached original materials
      originalMaterialsRef.current.forEach((mat) => {
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose())
        } else {
          mat.dispose()
        }
      })
      originalMaterialsRef.current.clear()
    }
  }, [fileUrl, fileType])

  // Apply material overrides to glTF scene when tint, preset, or wireframe changes
  const tintColor = tint?.color
  const tintOpacity = tint?.opacity
  useEffect(() => {
    if (!gltfScene) return

    const origMats = originalMaterialsRef.current
    const tinted = tintColor !== undefined && tintOpacity !== undefined
    const useOriginal =
      !tinted && hasEmbeddedColors && materialPreset === 'default' && !wireframe
    // Translucent comparison shells stay out of the shadow pass: they must
    // blend rather than occlude or double-shadow.
    const castsShadow = !tinted || tintOpacity >= 0.99

    gltfScene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      child.renderOrder = renderOrder

      // These flags do not inherit down the graph. Setting them on the
      // <primitive> group below did nothing, so glTF meshes — everything the
      // CAD converter produces — were absent from the shadow pass entirely.
      child.castShadow = castsShadow
      child.receiveShadow = true

      if (tinted) {
        // Comparison tint replaces everything, embedded colors included
        child.material = new THREE.MeshStandardMaterial({
          color: tintColor,
          metalness: 0.15,
          roughness: 0.6,
          transparent: true,
          opacity: tintOpacity,
          depthWrite: tintOpacity >= 0.99,
          wireframe,
        })
      } else if (useOriginal) {
        // Restore original glTF materials
        const orig = origMats.get(child.uuid)
        if (orig) {
          child.material = Array.isArray(orig)
            ? orig.map((m: THREE.Material) => m.clone())
            : orig.clone()
        }
      } else {
        // Override with preset material
        const mat = MATERIAL_PRESETS[materialPreset]
        child.material = new THREE.MeshStandardMaterial({
          color: wireframe ? '#3b82f6' : mat.color,
          metalness: wireframe ? 0.1 : mat.metalness,
          roughness: wireframe ? 0.8 : mat.roughness,
          wireframe,
        })
      }
    })
  }, [
    gltfScene,
    materialPreset,
    wireframe,
    hasEmbeddedColors,
    tintColor,
    tintOpacity,
    renderOrder,
  ])

  const mat = MATERIAL_PRESETS[materialPreset]
  // Translucent tints don't write depth or cast shadows — overlapping
  // version shells must blend rather than occlude or double-shadow
  const tintIsSolid = !tint || tint.opacity >= 0.99

  // Render glTF scene
  if (gltfScene) {
    return (
      // Shadow flags are set per-mesh in the traversal above, not here: a
      // group does not pass them to its children.
      <primitive ref={groupRef} object={gltfScene} visible={visible} />
    )
  }

  // Render STL/OBJ geometry
  if (!geometry) {
    return null
  }

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      visible={visible}
      renderOrder={renderOrder}
      castShadow={tintIsSolid}
      receiveShadow
    >
      <meshStandardMaterial
        color={tint ? tint.color : wireframe ? '#3b82f6' : mat.color}
        metalness={tint ? 0.15 : wireframe ? 0.1 : mat.metalness}
        roughness={tint ? 0.6 : wireframe ? 0.8 : mat.roughness}
        flatShading={false}
        wireframe={wireframe}
        transparent={Boolean(tint)}
        opacity={tint?.opacity ?? 1}
        depthWrite={tintIsSolid}
      />
    </mesh>
  )
}
