// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'
import { z } from 'zod'

/**
 * Stamping marks onto PDFs.
 *
 * Uses `@cantoo/pdf-lib` — the maintained MIT fork of `pdf-lib`, which has had
 * no release since 2022. MIT matters here: Cascadia is dual licensed, and its
 * proprietary edition cannot take an AGPL dependency such as MuPDF without a
 * commercial licence from Artifex.
 *
 * A stamp is drawn as new page content, not as a PDF annotation, so it cannot
 * be toggled off in a reader or stripped by "remove annotations". A person
 * looking at a superseded drawing has to see that it is superseded.
 */

export const WATERMARK_POSITIONS = [
  'diagonal',
  'top-banner',
  'bottom-banner',
] as const

export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export const watermarkOptionsSchema = z.object({
  /** The mark itself, e.g. 'SUPERSEDED' or 'UNCONTROLLED COPY'. */
  text: z.string().min(1).max(120),
  /** A second, smaller line — typically what replaced this revision. */
  subtext: z.string().max(200).nullable().optional(),
  position: z.enum(WATERMARK_POSITIONS).default('diagonal'),
  /** #rrggbb. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#dc2626'),
  /** 0..1. Low enough to read the drawing through, high enough to not miss. */
  opacity: z.number().min(0.05).max(1).default(0.25),
})

export type WatermarkOptions = z.input<typeof watermarkOptionsSchema>
type ResolvedWatermarkOptions = z.output<typeof watermarkOptionsSchema>

export interface WatermarkOutcome {
  bytes: Uint8Array
  pagesStamped: number
}

/**
 * Draw a watermark across every page of a PDF and return the new bytes.
 *
 * Throws if the input is not a PDF pdf-lib can parse, or if it is encrypted —
 * callers surface that as a per-file failure rather than failing the batch,
 * since one unreadable attachment should not stop the rest being marked.
 */
export async function applyWatermark(
  pdfBytes: Uint8Array,
  options: WatermarkOptions,
): Promise<WatermarkOutcome> {
  const resolved = watermarkOptionsSchema.parse(options)

  const pdf = await PDFDocument.load(pdfBytes, {
    // Some vendor-exported drawings carry an owner password with no user
    // password. They open fine in a reader and we can legitimately stamp them.
    ignoreEncryption: true,
    updateMetadata: false,
  })

  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  const color = hexToRgb(resolved.color)
  const pages = pdf.getPages()

  for (const page of pages) {
    const { width, height } = page.getSize()

    if (resolved.position === 'diagonal') {
      drawDiagonal(page, { font, color, width, height, options: resolved })
    } else {
      drawBanner(page, { font, color, width, height, options: resolved })
    }
  }

  return { bytes: await pdf.save(), pagesStamped: pages.length }
}

type Page = ReturnType<PDFDocument['getPages']>[number]
type Font = Awaited<ReturnType<PDFDocument['embedFont']>>

interface DrawArgs {
  font: Font
  color: { r: number; g: number; b: number }
  width: number
  height: number
  options: ResolvedWatermarkOptions
}

/**
 * A single line running corner to corner, sized so it spans about 80% of the
 * diagonal whatever the page dimensions — an A0 drawing sheet and a Letter
 * spec both end up legibly marked without a per-format table.
 */
function drawDiagonal(page: Page, args: DrawArgs): void {
  const { font, color, width, height, options } = args

  const diagonal = Math.sqrt(width * width + height * height)
  const angle = Math.atan2(height, width)
  const target = diagonal * 0.8

  const unitWidth = font.widthOfTextAtSize(options.text, 100) / 100
  const size = Math.max(8, target / Math.max(unitWidth, 0.001))
  const textWidth = font.widthOfTextAtSize(options.text, size)
  const textHeight = font.heightAtSize(size)

  // Centre the rotated baseline on the page centre.
  page.drawText(options.text, {
    x:
      width / 2 -
      (Math.cos(angle) * textWidth) / 2 +
      (Math.sin(angle) * textHeight) / 2,
    y:
      height / 2 -
      (Math.sin(angle) * textWidth) / 2 -
      (Math.cos(angle) * textHeight) / 2,
    size,
    font,
    color: rgb(color.r, color.g, color.b),
    opacity: options.opacity,
    rotate: degrees((angle * 180) / Math.PI),
  })

  if (options.subtext) {
    const subSize = Math.max(8, size * 0.16)
    const subWidth = font.widthOfTextAtSize(options.subtext, subSize)
    page.drawText(options.subtext, {
      x: (width - subWidth) / 2,
      y: height * 0.08,
      size: subSize,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity: Math.min(1, options.opacity + 0.35),
    })
  }
}

/**
 * A solid bar across the top or bottom. Preferred over the diagonal when the
 * sheet is dense — it obscures a fixed strip rather than the middle of the
 * drawing.
 */
function drawBanner(page: Page, args: DrawArgs): void {
  const { font, color, width, height, options } = args

  const bandHeight = Math.max(24, height * 0.055)
  const y = options.position === 'top-banner' ? height - bandHeight : 0

  page.drawRectangle({
    x: 0,
    y,
    width,
    height: bandHeight,
    color: rgb(color.r, color.g, color.b),
    opacity: options.opacity,
  })

  const size = fitText(font, options.text, width * 0.9, bandHeight * 0.5)
  const textWidth = font.widthOfTextAtSize(options.text, size)

  page.drawText(options.text, {
    x: (width - textWidth) / 2,
    y: y + bandHeight - size * 1.15,
    size,
    font,
    color: rgb(color.r, color.g, color.b),
    opacity: Math.min(1, options.opacity + 0.55),
  })

  if (options.subtext) {
    const subSize = Math.max(6, size * 0.5)
    const subWidth = font.widthOfTextAtSize(options.subtext, subSize)
    page.drawText(options.subtext, {
      x: (width - subWidth) / 2,
      y: y + bandHeight * 0.15,
      size: subSize,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity: Math.min(1, options.opacity + 0.55),
    })
  }
}

/** Largest size at which `text` fits both bounds. */
function fitText(
  font: Font,
  text: string,
  maxWidth: number,
  maxHeight: number,
): number {
  const unitWidth = font.widthOfTextAtSize(text, 100) / 100
  const byWidth = maxWidth / Math.max(unitWidth, 0.001)
  return Math.max(6, Math.min(byWidth, maxHeight))
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  }
}
