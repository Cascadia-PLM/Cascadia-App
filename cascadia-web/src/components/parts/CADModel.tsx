// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MATERIAL_PRESETS } from './CADViewerTypes'
import type { MaterialPreset } from './CADViewerTypes'
import type { ThreeEvent } from '@react-three/fiber'

/**
 * The geometry half of the CAD viewer: loading a file, dressing it in the
 * chosen material, and — for a structured assembly — letting the pointer
 * reach the individual parts inside it.
 *
 * Split out of `CADViewer` when picking arrived. The two halves never shared
 * state: everything above is a scene (camera, lights, controls, framing) and
 * everything here is a model, and they meet at the bounding box the loader
 * reports. If this file grows again the next seam is the loaders, which are
 * three independent format branches behind one effect.
 */

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
  /**
   * How many separately-selectable parts the model turned out to contain.
   *
   * Zero for every flat model — a single part, a non-STEP source, or an
   * assembly converted before the CAD converter began writing a glTF node per
   * part. Read it as "can this be taken apart", not as a part count.
   */
  partNodeCount: number
}

/**
 * glTF `extras` key the CAD converter writes a part's identity under.
 *
 * Must match `write_structured_glb` in `cascadia-workers-cad`. GLTFLoader
 * copies a node's `extras` onto `object.userData` verbatim, which is the whole
 * mechanism: the converter names the parts and three.js hands the names back.
 */
const NODE_KEY_EXTRA = 'cascadiaNodeKey'

/** Where the tag is cached on every mesh, so a raycast hit resolves in O(1). */
const NODE_KEY_USERDATA = 'cascadiaPartKey'

/** Emissive tints for the two highlight states, and how hard to drive them. */
const HIGHLIGHT = {
  selected: { color: 0x2563eb, intensity: 0.9 },
  hovered: { color: 0x1d4ed8, intensity: 0.35 },
} as const

/**
 * Copy each part node's key down onto its meshes.
 *
 * The converter writes one glTF node per part, but a part whose faces carry
 * more than one color becomes a *group* of meshes under that node — so the
 * object a raycast hits is usually a level or two below the object carrying
 * the identity. Caching the key on the meshes trades one walk at load time for
 * not walking up the parent chain on every pointer move.
 *
 * @returns how many part nodes were found, which is zero for a flat model.
 */
function tagPartNodes(scene: THREE.Object3D): number {
  let count = 0
  scene.traverse((node) => {
    const key: unknown = node.userData[NODE_KEY_EXTRA]
    if (typeof key !== 'string' || key === '') return
    count += 1
    node.traverse((descendant) => {
      descendant.userData[NODE_KEY_USERDATA] = key
    })
  })
  return count
}

/** The part a pointer event landed on, or null if it landed on a flat model. */
function pickedNodeKey(event: ThreeEvent<PointerEvent | MouseEvent>): string {
  const key: unknown = event.object.userData[NODE_KEY_USERDATA]
  return typeof key === 'string' ? key : ''
}

/** Every material on a mesh, whether it carries one or an array of them. */
function materialsOf(mesh: THREE.Mesh): Array<THREE.Material> {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

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

/**
 * Loads and displays the 3D geometry. STL, OBJ and glTF/GLB.
 *
 * For glTF files with embedded colors, supports switching between original
 * materials and preset overrides.
 *
 * A `tint` replaces every material with a flat translucent color — the
 * comparison overlay's rendering mode. Translucent tints skip depth writes
 * so two near-coincident shells blend instead of z-fighting; unchanged
 * regions read as the blend of both colors, differences as a single color.
 */
export function CADModel({
  fileUrl,
  fileType,
  wireframe = false,
  materialPreset = 'default',
  hasEmbeddedColors = false,
  tint = null,
  visible = true,
  renderOrder = 0,
  selectedNodeKey = null,
  hoveredNodeKey = null,
  onNodePointerMove,
  onNodePointerOut,
  onNodeClick,
  onNodeContextMenu,
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
  /** Part drawn as selected, by node key. */
  selectedNodeKey?: string | null
  /** Part drawn as hovered, by node key. */
  hoveredNodeKey?: string | null
  /**
   * Pointer handlers, by node key. Supplying any of them is what makes the
   * model interactive: R3F only raycasts against objects that have handlers,
   * so a viewer with nothing to select pays nothing per frame.
   */
  onNodePointerMove?: (nodeKey: string) => void
  onNodePointerOut?: () => void
  onNodeClick?: (nodeKey: string) => void
  onNodeContextMenu?: (nodeKey: string) => void
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

          const partNodeCount = tagPartNodes(scene)

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
            partNodeCount,
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
            // STL and OBJ carry no assembly structure at all — one mesh is
            // the whole file, whatever the source assembly looked like.
            partNodeCount: 0,
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

  // Light the selected and hovered parts.
  //
  // Deliberately a second pass that mutates `emissive` rather than a branch
  // inside the material effect above: that effect builds a new material per
  // mesh, so folding hover into it would rebuild every material in an
  // eighty-part assembly on each pointer move. It does have to re-run whenever
  // that effect does, though — a rebuilt material arrives with the highlight
  // gone — hence the shared dependencies, and the ordering that puts this
  // effect second in the same commit.
  useEffect(() => {
    if (!gltfScene) return
    if (selectedNodeKey === null && hoveredNodeKey === null) return

    const restore: Array<() => void> = []

    gltfScene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      const key: unknown = child.userData[NODE_KEY_USERDATA]
      const tone =
        key === selectedNodeKey
          ? HIGHLIGHT.selected
          : key === hoveredNodeKey
            ? HIGHLIGHT.hovered
            : null
      if (!tone) return

      for (const material of materialsOf(child)) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue

        const previousColor = material.emissive.getHex()
        const previousIntensity = material.emissiveIntensity
        restore.push(() => {
          material.emissive.setHex(previousColor)
          material.emissiveIntensity = previousIntensity
        })

        material.emissive.setHex(tone.color)
        material.emissiveIntensity = tone.intensity
      }
    })

    return () => {
      for (const undo of restore) undo()
    }
  }, [
    gltfScene,
    selectedNodeKey,
    hoveredNodeKey,
    // Everything the material effect above rebuilds materials for, so the
    // highlight is re-applied on top of the new ones rather than lost.
    materialPreset,
    wireframe,
    hasEmbeddedColors,
    tintColor,
    tintOpacity,
  ])

  const mat = MATERIAL_PRESETS[materialPreset]
  // Translucent tints don't write depth or cast shadows — overlapping
  // version shells must blend rather than occlude or double-shadow
  const tintIsSolid = !tint || tint.opacity >= 0.99

  // Render glTF scene
  if (gltfScene) {
    // R3F reports every object under the ray, nearest first, and calls the
    // handler once for each. Stopping propagation on the first is what makes
    // a click select the part in front rather than also the three behind it.
    const handle =
      (report: ((nodeKey: string) => void) | undefined) =>
      (event: ThreeEvent<PointerEvent | MouseEvent>) => {
        if (!report) return
        const key = pickedNodeKey(event)
        if (!key) return
        event.stopPropagation()
        report(key)
      }

    return (
      // Shadow flags are set per-mesh in the traversal above, not here: a
      // group does not pass them to its children.
      <primitive
        ref={groupRef}
        object={gltfScene}
        visible={visible}
        onPointerMove={
          onNodePointerMove ? handle(onNodePointerMove) : undefined
        }
        onPointerOut={onNodePointerOut ? () => onNodePointerOut() : undefined}
        onClick={onNodeClick ? handle(onNodeClick) : undefined}
        onContextMenu={
          onNodeContextMenu ? handle(onNodeContextMenu) : undefined
        }
      />
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
