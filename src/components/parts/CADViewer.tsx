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
  Center,
  ContactShadows,
  Environment,
  GizmoHelper,
  GizmoViewcube,
  Grid,
  OrbitControls,
  PerspectiveCamera,
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
  /** Loading callback */
  onLoad?: (stats: { polygonCount: number; boundingBox: THREE.Vector3 }) => void
  /** Error callback */
  onError?: (error: Error) => void
}

/**
 * 3D CAD Model Viewer Component
 * Supports STL and OBJ file formats with orbit controls
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
      onLoad,
      onError,
    },
    ref,
  ) {
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [modelBounds, setModelBounds] = useState<THREE.Vector3 | null>(null)
    const controlsRef = useRef<any>(null)
    const cameraRef = useRef<THREE.PerspectiveCamera>(null)

    // Calculate optimal camera distance based on model size
    const getOptimalCameraDistance = (bounds: THREE.Vector3): number => {
      const maxDimension = Math.max(bounds.x, bounds.y, bounds.z)
      // Use FOV to calculate distance that fits the model with some padding
      const fov = 50 * (Math.PI / 180) // Convert to radians
      const distance = maxDimension / 2 / Math.tan(fov / 2)
      return distance * 1.5 // Add 50% padding for comfortable viewing
    }

    // Reset camera view to fit model
    const resetView = () => {
      if (controlsRef.current && cameraRef.current && modelBounds) {
        const distance = getOptimalCameraDistance(modelBounds)
        cameraRef.current.position.set(distance * 0.5, distance * 0.3, distance)
        cameraRef.current.up.set(0, 1, 0)
        cameraRef.current.lookAt(0, 0, 0)
        controlsRef.current.target.set(0, 0, 0)
        controlsRef.current.update()
      }
    }

    // Set camera to a standard view
    const setView = (view: StandardView) => {
      if (!controlsRef.current || !cameraRef.current || !modelBounds) return

      const distance = getOptimalCameraDistance(modelBounds)
      const camera = cameraRef.current
      const controls = controlsRef.current

      // Always reset up vector before setting position
      camera.up.set(0, 1, 0)

      switch (view) {
        case 'front':
          camera.position.set(0, 0, distance)
          break
        case 'back':
          camera.position.set(0, 0, -distance)
          break
        case 'left':
          camera.position.set(-distance, 0, 0)
          break
        case 'right':
          camera.position.set(distance, 0, 0)
          break
        case 'top':
          camera.position.set(0, distance, 0)
          camera.up.set(0, 0, -1)
          break
        case 'bottom':
          camera.position.set(0, -distance, 0)
          camera.up.set(0, 0, 1)
          break
        case 'iso':
          camera.position.set(distance * 0.5, distance * 0.3, distance)
          break
      }

      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      controls.update()
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

    const handleError = (err: Error) => {
      const message = `Failed to load ${fileType.toUpperCase()} file: ${err.message}`
      setError(message)
      setIsLoading(false)
      onError?.(err)
    }

    const handleModelLoad = (stats: {
      polygonCount: number
      boundingBox: THREE.Vector3
    }) => {
      setModelBounds(stats.boundingBox)
      setIsLoading(false)
      onLoad?.(stats)
    }

    if (error) {
      return (
        <div className="flex items-center justify-center h-full bg-slate-100 dark:bg-slate-800 rounded-lg">
          <div className="text-center p-8">
            <p className="text-red-500 dark:text-red-400 font-medium mb-2">
              Error Loading Model
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {error}
            </p>
          </div>
        </div>
      )
    }

    // Calculate dynamic zoom limits based on model size
    const maxDim = modelBounds
      ? Math.max(modelBounds.x, modelBounds.y, modelBounds.z)
      : 100
    const minZoomDistance = Math.max(0.1, maxDim * 0.01)
    const maxZoomDistance = Math.max(1000, maxDim * 10)
    const initialCameraDistance = modelBounds
      ? getOptimalCameraDistance(modelBounds)
      : 5

    const bgConfig = BACKGROUND_PRESETS[backgroundPreset]

    // Calculate grid cell size based on model bounds
    const gridCellSize = modelBounds
      ? Math.pow(
          10,
          Math.floor(
            Math.log10(
              Math.max(modelBounds.x, modelBounds.y, modelBounds.z) / 5,
            ),
          ),
        )
      : 1

    // Grid Y offset — position below the model
    const gridY = modelBounds ? -(modelBounds.y / 2) - 0.01 : 0

    return (
      <div className="relative w-full h-full rounded-lg overflow-hidden">
        {isLoading && (
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
            near={0.01}
            far={maxZoomDistance * 2}
          />

          {/* Scene Background */}
          <SceneBackground
            topColor={bgConfig.topColor}
            bottomColor={bgConfig.bottomColor}
          />

          {/* Lighting */}
          <ambientLight intensity={0.5} />
          <directionalLight
            position={[10, 10, 5]}
            intensity={1}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
          />
          <directionalLight position={[-10, -10, -5]} intensity={0.3} />

          {/* Environment for reflections */}
          <Suspense fallback={null}>
            <Environment preset={bgConfig.environmentPreset as any} />
          </Suspense>

          {/* Model */}
          <Suspense fallback={null}>
            <Center>
              <Model
                fileUrl={fileUrl}
                fileType={fileType}
                wireframe={wireframe}
                materialPreset={materialPreset}
                hasEmbeddedColors={hasEmbeddedColors}
                onLoad={handleModelLoad}
                onError={handleError}
              />
            </Center>
          </Suspense>

          {/* Grid */}
          {showGrid && (
            <Grid
              position={[0, gridY, 0]}
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
              position={[0, gridY, 0]}
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

          {/* Controls with dynamic zoom limits */}
          <OrbitControls
            ref={controlsRef}
            enableDamping
            dampingFactor={0.05}
            rotateSpeed={0.5}
            zoomSpeed={1.0}
            panSpeed={0.5}
            minDistance={minZoomDistance}
            maxDistance={maxZoomDistance}
          />

          {/* Auto-fit camera when model loads */}
          {modelBounds && (
            <CameraAutoFit bounds={modelBounds} controlsRef={controlsRef} />
          )}
        </Canvas>

        {/* File name overlay */}
        {fileName && !isLoading && (
          <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {fileName}
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

/**
 * Component to auto-fit camera to model bounds on initial load
 */
function CameraAutoFit({
  bounds,
  controlsRef,
}: {
  bounds: THREE.Vector3
  controlsRef: React.RefObject<any>
}) {
  const { camera } = useThree()
  const hasAutoFit = useRef(false)

  useEffect(() => {
    if (hasAutoFit.current) return
    hasAutoFit.current = true

    const maxDimension = Math.max(bounds.x, bounds.y, bounds.z)
    const fov = 50 * (Math.PI / 180)
    const distance = (maxDimension / 2 / Math.tan(fov / 2)) * 1.5

    camera.position.set(distance * 0.5, distance * 0.3, distance)
    camera.lookAt(0, 0, 0)

    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0)
      controlsRef.current.update()
    }
  }, [bounds, camera, controlsRef])

  return null
}

/**
 * Internal Model component that loads and displays the 3D geometry.
 * Supports STL, OBJ, and glTF/GLB file formats.
 * For glTF files with embedded colors, supports switching between
 * original materials and preset overrides.
 */
function Model({
  fileUrl,
  fileType,
  wireframe = false,
  materialPreset = 'default',
  hasEmbeddedColors = false,
  onLoad,
  onError,
}: {
  fileUrl: string
  fileType: string
  wireframe?: boolean
  materialPreset?: MaterialPreset
  hasEmbeddedColors?: boolean
  onLoad: (stats: { polygonCount: number; boundingBox: THREE.Vector3 }) => void
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
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh
          mesh.geometry?.dispose()
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose())
          } else if (mesh.material) {
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
          box.getSize(size)

          disposablesRef.current = { geometry: null, gltfScene: scene }
          setGltfScene(scene)
          setGeometry(null) // Clear any previous geometry
          onLoadRef.current({
            polygonCount: Math.floor(totalPolygons),
            boundingBox: size,
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

            if (meshes.length === 0) {
              throw new Error('No geometry found in OBJ file')
            }

            loadedGeometry = meshes[0]
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
          if (boundingBox) {
            boundingBox.getSize(size)
          }

          const polygonCount = loadedGeometry.index
            ? loadedGeometry.index.count / 3
            : loadedGeometry.attributes.position.count / 3

          disposablesRef.current = { geometry: loadedGeometry, gltfScene: null }
          setGeometry(loadedGeometry)
          setGltfScene(null) // Clear any previous glTF scene
          originalMaterialsRef.current.clear()
          onLoadRef.current({
            polygonCount: Math.floor(polygonCount),
            boundingBox: size,
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

  // Apply material overrides to glTF scene when preset or wireframe changes
  useEffect(() => {
    if (!gltfScene) return

    const origMats = originalMaterialsRef.current
    const useOriginal =
      hasEmbeddedColors && materialPreset === 'default' && !wireframe

    gltfScene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      if (useOriginal) {
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
  }, [gltfScene, materialPreset, wireframe, hasEmbeddedColors])

  const mat = MATERIAL_PRESETS[materialPreset]

  // Render glTF scene
  if (gltfScene) {
    return (
      <primitive ref={groupRef} object={gltfScene} castShadow receiveShadow />
    )
  }

  // Render STL/OBJ geometry
  if (!geometry) {
    return null
  }

  return (
    <mesh ref={meshRef} geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={wireframe ? '#3b82f6' : mat.color}
        metalness={wireframe ? 0.1 : mat.metalness}
        roughness={wireframe ? 0.8 : mat.roughness}
        flatShading={false}
        wireframe={wireframe}
      />
    </mesh>
  )
}
