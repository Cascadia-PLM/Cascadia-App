// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which vault files are native CAD authoring documents: the file a CAD
 * application opens, edits and saves, as opposed to something exported from
 * one.
 *
 * The distinction matters to the item-number naming mode
 * (`VAULT_NATIVE_CAD_NAMING=itemNumber`), which renames exactly these files to
 * `<itemNumber>.<ext>`. Native files reference each other by filename — an
 * assembly names its parts, a drawing names its model — so a PDM deployment
 * wants their names owned by the vault rather than by whatever the local copy
 * happened to be called. Exports have no such references and their names are
 * often chosen on purpose, so they are left alone:
 *
 * - **Neutral exchange formats** — STEP, IGES, Parasolid, ACIS, JT. Written
 *   for another system to read; a supplier's `housing_rev3.step` is named the
 *   way it was received.
 * - **Mesh and visualization formats** — STL, OBJ, glTF/GLB, 3MF, PLY, FBX.
 *   Derived for printing or viewing, frequently by the CAD converter itself.
 *
 * `.dwg`/`.dxf` count as native: AutoCAD, BricsCAD and most 2D packages author
 * in them directly. Rhino's `.3dm` is likewise Rhino's own document format.
 *
 * Deliberately free of Node imports so client bundles can import it, like the
 * rest of this directory.
 */

export const NATIVE_CAD_EXTENSIONS = [
  // SolidWorks
  '.sldprt',
  '.sldasm',
  '.slddrw',
  // Autodesk Inventor
  '.ipt',
  '.iam',
  '.idw',
  // AutoCAD, BricsCAD and other DWG-based 2D tools
  '.dwg',
  '.dxf',
  // PTC Creo / Pro-ENGINEER and Siemens NX (`.prt` and `.asm` are shared)
  '.prt',
  '.asm',
  '.drw',
  '.frm',
  '.lay',
  '.sec',
  // CATIA V5
  '.catpart',
  '.catproduct',
  '.catdrawing',
  // Solid Edge
  '.par',
  '.psm',
  '.pwd',
  '.dft',
  // FreeCAD
  '.fcstd',
  // Autodesk Fusion
  '.f3d',
  '.f3z',
  // Rhino
  '.3dm',
] as const

const NATIVE_CAD_EXTENSION_SET: ReadonlySet<string> = new Set(
  NATIVE_CAD_EXTENSIONS,
)

/** Extension of a file name, lowercased, `''` when there is none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and dotfiles like ".sldprt"
  return dot <= 0 ? '' : fileName.slice(dot).toLowerCase()
}

/** Whether a file is a native CAD authoring document, judged by extension. */
export function isNativeCadFile(fileName: string): boolean {
  return NATIVE_CAD_EXTENSION_SET.has(extensionOf(fileName))
}
