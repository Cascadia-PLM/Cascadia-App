// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import crypto from 'node:crypto'
import path from 'node:path'
import {
  DISPLAYABLE_IMAGE_EXTENSIONS,
  isDisplayableImage,
} from '../image-files'
import type { FileCategory } from '../file-categories'

/**
 * Sanitize filename to remove dangerous characters
 * Preserves the file extension
 */
export function sanitizeFilename(filename: string): string {
  // Get extension
  const ext = path.extname(filename)
  const name = path.basename(filename, ext)

  // Remove dangerous characters, allow only alphanumeric, dash, underscore, and space
  const sanitized = name
    .replace(/[^a-zA-Z0-9\s_-]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200) // Limit length

  return sanitized + ext
}

/**
 * Generate SHA256 hash of file data
 */
export function generateFileHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Generate storage path for a file
 * Format: /{masterId}/{revision}/{fileId}/{version}/{filename}
 */
export function generateStoragePath(
  masterId: string,
  revision: string,
  fileId: string,
  version: number,
  filename: string,
): string {
  const sanitized = sanitizeFilename(filename)
  // Use forward slashes always - these are logical storage paths that must work
  // cross-platform (e.g., Windows app server + Linux Docker converter worker)
  return [masterId, revision, fileId, version.toString(), sanitized].join('/')
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

/**
 * Get MIME type icon/category
 */
export function getMimeTypeCategory(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.includes('pdf')) return 'pdf'
  if (mimeType.includes('word') || mimeType.includes('document'))
    return 'document'
  if (mimeType.includes('sheet') || mimeType.includes('excel'))
    return 'spreadsheet'
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint'))
    return 'presentation'
  if (
    mimeType.includes('zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('compressed')
  )
    return 'archive'
  if (mimeType.includes('text/')) return 'text'

  // CAD file types
  if (mimeType.includes('solidworks') || mimeType.includes('sld')) return 'cad'
  if (mimeType.includes('autocad') || mimeType.includes('dwg')) return 'cad'
  if (mimeType.includes('step') || mimeType.includes('iges')) return 'cad'

  return 'file'
}

/**
 * Validate file size against max limit
 */
export function validateFileSize(
  size: number,
  maxSizeBytes: number = 100 * 1024 * 1024,
): boolean {
  return size <= maxSizeBytes
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  return path.extname(filename).toLowerCase()
}

/**
 * Allowed file extensions for a PLM system (allowlist approach).
 * Only these extensions are accepted; everything else is rejected.
 */
const ALLOWED_EXTENSIONS = new Set([
  // CAD files
  '.step',
  '.stp',
  '.iges',
  '.igs',
  '.stl',
  '.obj',
  '.sldprt',
  '.sldasm',
  '.prt',
  '.asm',
  '.catpart',
  '.catproduct',
  '.x_t',
  '.x_b',
  '.sat',
  '.3mf',
  '.glb',
  '.gltf',
  '.dwg',
  '.dxf',
  '.ipt',
  '.iam',
  '.idw',
  '.3dm',
  '.ply',
  // Solid Edge
  '.par',
  '.psm',
  '.dft',
  '.pwd',
  // SolidWorks drawing
  '.slddrw',
  // Creo / Pro-E (.prt and .asm shared above)
  '.drw',
  '.frm',
  '.lay',
  '.sec',
  // CATIA drawing
  '.catdrawing',
  // Fusion 360
  '.f3d',
  '.f3z',
  // FreeCAD
  '.fcstd',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.rtf',
  '.ppt',
  '.pptx',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.svg',
  '.webp',
  // Archives
  '.zip',
  '.7z',
  '.tar',
  '.gz',
  // Data
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  // Firmware build artifacts
  '.bin',
  '.hex',
  '.elf',
])

/**
 * Check if file type is allowed using an allowlist approach.
 * Only PLM-relevant file types (CAD, documents, images, archives, data) are accepted.
 */
export function isFileTypeAllowed(
  filename: string,
  _mimeType: string,
): boolean {
  const ext = getFileExtension(filename)
  if (!ext) return false
  return ALLOWED_EXTENSIONS.has(ext)
}

/**
 * Get the full list of allowed file extensions.
 * Use this when reporting errors so the message stays in sync with the allowlist.
 */
export function getAllowedExtensions(): Array<string> {
  return Array.from(ALLOWED_EXTENSIONS)
}

/**
 * Check if a file can be used as an item thumbnail image.
 *
 * The rule itself lives in the client-safe `../image-files` so the UI can ask
 * the same question this module answers for uploads.
 */
export function isThumbnailableImage(
  filename: string,
  mimeType: string,
): boolean {
  return isDisplayableImage(filename, mimeType)
}

/**
 * Get the full list of extensions accepted as an item thumbnail.
 */
export function getThumbnailImageExtensions(): Array<string> {
  return [...DISPLAYABLE_IMAGE_EXTENSIONS]
}

/**
 * Check if a file is a CAD model based on extension
 */
export function isCADFile(filename: string): boolean {
  const ext = getFileExtension(filename)
  const cadExtensions = [
    '.stl', // STL (Stereolithography)
    '.obj', // Wavefront OBJ
    '.step', // STEP (ISO 10303)
    '.stp', // STEP (alternate extension)
    '.iges', // IGES
    '.igs', // IGES (alternate extension)
    '.sldprt', // SolidWorks Part
    '.sldasm', // SolidWorks Assembly
    '.prt', // Various CAD formats (Creo/NX part)
    '.asm', // Assembly (Solid Edge / Creo / NX)
    '.par', // Solid Edge Part
    '.psm', // Solid Edge Sheet Metal
    '.pwd', // Solid Edge Weldment
    '.dwg', // AutoCAD Drawing
    '.dxf', // AutoCAD DXF
    '.ipt', // Autodesk Inventor Part
    '.iam', // Autodesk Inventor Assembly
    '.catpart', // CATIA Part
    '.catproduct', // CATIA Product
    '.f3d', // Fusion 360
    '.f3z', // Fusion 360 archive
    '.fcstd', // FreeCAD document
    '.3dm', // Rhino 3D
    '.ply', // Polygon File Format
    '.glb', // glTF Binary
    '.gltf', // glTF
  ]
  return cadExtensions.includes(ext)
}

/**
 * Build a filename-hint matcher.
 *
 * Each term must appear as a whole token — bounded by the start of the name or
 * a separator — so "inspection" is not read as a "spec" and "feature" is not
 * read as an "fea" run. Underscores count as separators: uploads routinely use
 * them in place of spaces, and `sanitizeFilename` produces them too.
 */
function nameHint(...terms: Array<string>): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])(?:${terms.join('|')})(?![a-z0-9])`)
}

const DRAWING_NAME_HINT = nameHint('drawings?', 'dwgs?')
const ANALYSIS_NAME_HINT = nameHint(
  'analys[ei]s',
  'fea',
  'simulations?',
  'simulated',
)
const SPECIFICATION_NAME_HINT = nameHint(
  'specs?',
  'specifications?',
  'requirements?',
  'data[\\s_-]?sheets?',
)

/**
 * Container formats that carry no type information in the extension — a file
 * of one of these can be a spec, a certificate, a test report, a drawing, or
 * anything else.
 */
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.rtf', '.odt', '.txt']

/**
 * Detect file category based on filename and mime type.
 *
 * Extensions decide the category only when the format itself is unambiguous
 * (a `.sldprt` is always a model, a `.slddrw` is always a drawing). Container
 * formats fall through to filename hints, and an unhinted file stays
 * 'reference' — an unlabeled default beats a confidently wrong one.
 *
 * This is a guess from the filename, nothing more. A person can overrule it
 * with `FileService.setFileCategory`, which marks the category as manual so
 * re-detection leaves it alone.
 */
export function detectFileCategory(
  filename: string,
  mimeType: string,
): FileCategory {
  const ext = getFileExtension(filename)
  const lowerFilename = filename.toLowerCase()

  // CAD model files
  const cadModelExtensions = [
    '.stl',
    '.obj',
    '.step',
    '.stp',
    '.iges',
    '.igs',
    '.sldprt',
    '.prt',
    '.par',
    '.psm',
    '.pwd',
    '.ipt',
    '.catpart',
    '.f3d',
    '.f3z',
    '.fcstd',
    '.3dm',
    '.ply',
    '.glb',
    '.gltf',
  ]
  if (cadModelExtensions.includes(ext)) {
    return 'cad_model'
  }

  // Assembly files
  const assemblyExtensions = ['.sldasm', '.iam', '.catproduct', '.asm']
  if (assemblyExtensions.includes(ext)) {
    return 'cad_model'
  }

  // Native 2D drawing formats. `.pdf` is deliberately NOT here: a PDF is a
  // container, not a content type, so it is classified by filename below.
  const drawingExtensions = [
    '.dwg',
    '.dxf',
    '.dft', // Solid Edge Draft
    '.slddrw', // SolidWorks Drawing
    '.idw', // Inventor Drawing
    '.drw', // Creo Drawing
    '.catdrawing', // CATIA Drawing
  ]
  if (drawingExtensions.includes(ext)) {
    return 'drawing'
  }

  // Drawings exported to a container format
  if (DRAWING_NAME_HINT.test(lowerFilename)) {
    return 'drawing'
  }

  // Analysis/simulation files
  if (ANALYSIS_NAME_HINT.test(lowerFilename)) {
    return 'analysis'
  }

  // Specification/documentation
  const isDocument =
    DOCUMENT_EXTENSIONS.includes(ext) ||
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('document')
  if (isDocument && SPECIFICATION_NAME_HINT.test(lowerFilename)) {
    return 'specification'
  }

  // Default to reference
  return 'reference'
}

/**
 * Get CAD file format name from extension
 */
export function getCADFormat(filename: string): string | null {
  const ext = getFileExtension(filename)
  const formats: Record<string, string> = {
    '.stl': 'STL',
    '.obj': 'OBJ',
    '.step': 'STEP',
    '.stp': 'STEP',
    '.iges': 'IGES',
    '.igs': 'IGES',
    '.sldprt': 'SolidWorks',
    '.sldasm': 'SolidWorks',
    '.slddrw': 'SolidWorks',
    '.dwg': 'AutoCAD',
    '.dxf': 'AutoCAD DXF',
    '.ipt': 'Inventor',
    '.iam': 'Inventor',
    '.idw': 'Inventor',
    '.par': 'Solid Edge',
    '.psm': 'Solid Edge',
    '.asm': 'Solid Edge',
    '.dft': 'Solid Edge',
    '.pwd': 'Solid Edge',
    '.prt': 'Creo/NX',
    '.drw': 'Creo',
    '.frm': 'Creo',
    '.lay': 'Creo',
    '.sec': 'Creo',
    '.catpart': 'CATIA',
    '.catproduct': 'CATIA',
    '.catdrawing': 'CATIA',
    '.f3d': 'Fusion 360',
    '.f3z': 'Fusion 360',
    '.fcstd': 'FreeCAD',
    '.3dm': 'Rhino',
    '.ply': 'PLY',
    '.glb': 'glTF',
    '.gltf': 'glTF',
  }
  return formats[ext] || null
}

/**
 * Check if CAD file format is supported for 3D viewing
 */
export function isCADViewable(filename: string): boolean {
  const ext = getFileExtension(filename)
  // Phase 1: Support STL and OBJ
  const viewableExtensions = ['.stl', '.obj']
  return viewableExtensions.includes(ext)
}

/**
 * Extract basic metadata from a file.
 *
 * Returns extension, MIME category, detected file category, CAD format info for
 * CAD extensions, and — for PDFs under the parser's size cap — page count and
 * document properties.
 *
 * Content-based extraction stops there, deliberately:
 *
 * - **No image EXIF.** Reading it needs `sharp` or `exif-parser`, neither in the
 *   tree, and both native. This module lives in `packages/core`, the published
 *   AGPL package, so that binary would land in every community-edition install —
 *   for fields nothing in the app reads today.
 * - **No native CAD property parsing.** Converted CAD already gets units,
 *   polygon count and bounding box written to the typed `cadMetadata` column by
 *   the Python converter worker. What is left is vendor formats (`.sldprt`,
 *   `.catpart`, `.ipt`) that no in-tree parser reads and that realistically need
 *   a vendor SDK.
 */
export async function extractFileMetadata(
  filename: string,
  mimeType: string,
  data: Buffer,
): Promise<Record<string, any>> {
  const metadata: Record<string, any> = {
    extension: getFileExtension(filename),
    category: getMimeTypeCategory(mimeType),
  }

  // Detect file category
  const fileCategory = detectFileCategory(filename, mimeType)
  metadata.detectedCategory = fileCategory

  // Add CAD-specific metadata if applicable
  if (isCADFile(filename)) {
    metadata.cadFormat = getCADFormat(filename)
    metadata.isViewable = isCADViewable(filename)
  }

  // Extension, never the caller-supplied mimeType — the browser asserts that at
  // upload time, while the extension has already passed the allowlist above.
  // The import is dynamic on purpose: this module is imported by client
  // components for `formatFileSize`, and a static pdf-lib import here would pull
  // the PDF stack into the browser bundle. `node-handlers/watermark.ts` does the
  // same for the same reason.
  if (getFileExtension(filename) === '.pdf') {
    const { extractPdfMetadata } = await import('../pdf/metadata')
    const pdf = await extractPdfMetadata(data)
    if (pdf) Object.assign(metadata, pdf)
  }

  return metadata
}
