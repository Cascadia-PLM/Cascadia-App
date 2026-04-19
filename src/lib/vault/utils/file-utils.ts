import crypto from 'node:crypto'
import path from 'node:path'

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
  '.3dm',
  '.ply',
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
    '.prt', // Various CAD formats
    '.dwg', // AutoCAD Drawing
    '.dxf', // AutoCAD DXF
    '.ipt', // Autodesk Inventor Part
    '.iam', // Autodesk Inventor Assembly
    '.catpart', // CATIA Part
    '.catproduct', // CATIA Product
    '.3dm', // Rhino 3D
    '.ply', // Polygon File Format
    '.glb', // glTF Binary
    '.gltf', // glTF
  ]
  return cadExtensions.includes(ext)
}

/**
 * Detect file category based on filename and mime type
 * Returns: 'cad_model', 'drawing', 'specification', 'analysis', 'reference', or 'other'
 */
export function detectFileCategory(filename: string, mimeType: string): string {
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
    '.ipt',
    '.catpart',
    '.3dm',
    '.ply',
    '.glb',
    '.gltf',
  ]
  if (cadModelExtensions.includes(ext)) {
    return 'cad_model'
  }

  // Drawing files
  const drawingExtensions = ['.dwg', '.dxf', '.pdf']
  if (
    drawingExtensions.includes(ext) ||
    lowerFilename.includes('drawing') ||
    lowerFilename.includes('dwg')
  ) {
    return 'drawing'
  }

  // Analysis/simulation files
  if (
    lowerFilename.includes('analysis') ||
    lowerFilename.includes('fea') ||
    lowerFilename.includes('simulation')
  ) {
    return 'analysis'
  }

  // Specification/documentation
  if (
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('document')
  ) {
    if (
      lowerFilename.includes('spec') ||
      lowerFilename.includes('requirement') ||
      lowerFilename.includes('datasheet')
    ) {
      return 'specification'
    }
  }

  // Assembly files
  const assemblyExtensions = ['.sldasm', '.iam', '.catproduct']
  if (assemblyExtensions.includes(ext)) {
    return 'cad_model'
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
    '.dwg': 'AutoCAD',
    '.dxf': 'AutoCAD DXF',
    '.ipt': 'Inventor',
    '.iam': 'Inventor',
    '.catpart': 'CATIA',
    '.catproduct': 'CATIA',
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
 * Currently returns extension, MIME category, detected file category, and CAD format info.
 * Full content-based extraction (PDF properties, image EXIF, CAD polygon counts) is deferred to Phase 1.5.
 */
export function extractFileMetadata(
  filename: string,
  mimeType: string,
  _data: Buffer,
): Record<string, any> {
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

  // TODO: Phase 1.5 - Add metadata extraction
  // - PDF: Use pdf-parse to extract title, author, page count
  // - Images: Use sharp/exif-parser for EXIF data
  // - CAD: Integration with CAD parsers for properties (polygon count, dimensions)

  return metadata
}
