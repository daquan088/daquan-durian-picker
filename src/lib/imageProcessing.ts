export const IMAGE_MAX_BYTES = 25 * 1024 * 1024
export const PROCESSED_IMAGE_MAX_BYTES = 70 * 1024
export const PROCESSED_IMAGE_MAX_EDGE = 1280
export const CANDIDATE_IMAGE_MAX_BYTES = 18 * 1024
export const CANDIDATE_IMAGE_MAX_EDGE = 768

export type ImageProcessingErrorCode = 'IMAGE_TOO_LARGE' | 'INVALID_IMAGE' | 'UNSUPPORTED_MEDIA_TYPE'

export class ImageProcessingError extends Error {
  constructor(readonly code: ImageProcessingErrorCode, message: string) {
    super(message)
    this.name = 'ImageProcessingError'
  }
}

export interface DecodedImageBitmap {
  width: number
  height: number
  close(): void
}

export interface CanvasSurface {
  canvas: { width: number; height: number }
  context: {
    drawImage(image: DecodedImageBitmap, x: number, y: number, width: number, height: number): void
  }
}

export interface ImageProcessingAdapter {
  createImageBitmap(file: Blob, options: ImageBitmapOptions): Promise<DecodedImageBitmap>
  createCanvas(width: number, height: number): CanvasSurface
  toBlob(surface: CanvasSurface, type: string, quality: number): Promise<Blob | null>
  readAsDataURL(blob: Blob): Promise<string>
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

export interface ProcessedImage {
  blob: Blob
  dataUrl: string
  width: number
  height: number
  previewUrl: string
  revoke(): void
}

interface CompressionAttempt {
  scale: number
  quality: number
}

interface ImageProcessingProfile {
  maxBytes: number
  maxEdge: number
  label: string
  attempts: readonly CompressionAttempt[]
}

// Fixed attempts prevent pathological files from causing an unbounded encode loop.
// Preserve full resolution first, then lower JPEG quality, then reduce dimensions.
const OVERVIEW_COMPRESSION_ATTEMPTS: readonly CompressionAttempt[] = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.72 },
  { scale: 0.8, quality: 0.72 },
  { scale: 0.65, quality: 0.68 },
  { scale: 0.5, quality: 0.55 },
  { scale: 0.4, quality: 0.5 },
  { scale: 0.3, quality: 0.45 },
]

const CANDIDATE_COMPRESSION_ATTEMPTS: readonly CompressionAttempt[] = [
  { scale: 1, quality: 0.82 },
  { scale: 1, quality: 0.68 },
  { scale: 0.85, quality: 0.68 },
  { scale: 0.72, quality: 0.64 },
  { scale: 0.6, quality: 0.6 },
  { scale: 0.5, quality: 0.56 },
  { scale: 0.4, quality: 0.52 },
  { scale: 0.3, quality: 0.45 },
  { scale: 0.25, quality: 0.4 },
]

const OVERVIEW_PROFILE: ImageProcessingProfile = {
  maxBytes: PROCESSED_IMAGE_MAX_BYTES,
  maxEdge: PROCESSED_IMAGE_MAX_EDGE,
  label: '70 KiB',
  attempts: OVERVIEW_COMPRESSION_ATTEMPTS,
}

const CANDIDATE_PROFILE: ImageProcessingProfile = {
  maxBytes: CANDIDATE_IMAGE_MAX_BYTES,
  maxEdge: CANDIDATE_IMAGE_MAX_EDGE,
  label: '18 KiB',
  attempts: CANDIDATE_COMPRESSION_ATTEMPTS,
}

function invalidImage(message: string): ImageProcessingError {
  return new ImageProcessingError('INVALID_IMAGE', message)
}

function clearCanvas(surface: CanvasSurface): void {
  surface.canvas.width = 0
  surface.canvas.height = 0
}

function createBrowserAdapter(): ImageProcessingAdapter {
  return {
    createImageBitmap: (file, options) => globalThis.createImageBitmap(file, options),
    createCanvas(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) {
        throw invalidImage('Unable to create a canvas context.')
      }

      return {
        canvas,
        context: {
          drawImage(image, x, y, drawWidth, drawHeight) {
            context.drawImage(image as ImageBitmap, x, y, drawWidth, drawHeight)
          },
        },
      }
    },
    toBlob(surface, type, quality) {
      return new Promise((resolve) => {
        ;(surface.canvas as HTMLCanvasElement).toBlob(resolve, type, quality)
      })
    },
    readAsDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read JPEG output.'))
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error('JPEG output did not produce a data URL.'))
            return
          }
          resolve(reader.result)
        }
        reader.readAsDataURL(blob)
      })
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  }
}

function scaledDimension(dimension: number, scale: number): number {
  return Math.max(1, Math.round(dimension * scale))
}

async function encodeJpeg(
  adapter: ImageProcessingAdapter,
  bitmap: DecodedImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  let surface: CanvasSurface | undefined
  try {
    surface = adapter.createCanvas(width, height)
    surface.context.drawImage(bitmap, 0, 0, width, height)
    const blob = await adapter.toBlob(surface, 'image/jpeg', quality)
    if (blob === null || blob.size === 0 || blob.type !== 'image/jpeg') {
      throw invalidImage('Unable to encode the image as JPEG.')
    }
    return blob
  } finally {
    if (surface !== undefined) {
      clearCanvas(surface)
    }
  }
}

function createConfiguredImageProcessor(adapter: ImageProcessingAdapter, profile: ImageProcessingProfile) {
  return async function processImage(file: File): Promise<ProcessedImage> {
    if (!file || !Number.isFinite(file.size) || file.size <= 0) {
      throw invalidImage('The image file is empty or invalid.')
    }
    if (file.size > IMAGE_MAX_BYTES) {
      throw new ImageProcessingError('IMAGE_TOO_LARGE', 'The image exceeds the 25 MiB upload limit.')
    }
    if (!file.type.startsWith('image/')) {
      throw new ImageProcessingError('UNSUPPORTED_MEDIA_TYPE', 'Please choose a browser-decodable image file.')
    }

    let bitmap: DecodedImageBitmap | undefined
    try {
      try {
        bitmap = await adapter.createImageBitmap(file, { imageOrientation: 'from-image' })
      } catch {
        throw invalidImage('The selected file could not be decoded as an image.')
      }

      if (bitmap == null || !Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0) {
        throw invalidImage('The decoded image has invalid dimensions.')
      }

      const initialScale = Math.min(1, profile.maxEdge / Math.max(bitmap.width, bitmap.height))
      const baseWidth = scaledDimension(bitmap.width, initialScale)
      const baseHeight = scaledDimension(bitmap.height, initialScale)

      for (const attempt of profile.attempts) {
        const width = scaledDimension(baseWidth, attempt.scale)
        const height = scaledDimension(baseHeight, attempt.scale)
        let blob: Blob
        try {
          blob = await encodeJpeg(adapter, bitmap, width, height, attempt.quality)
        } catch (error) {
          if (error instanceof ImageProcessingError) throw error
          throw invalidImage('Unable to encode the image as JPEG.')
        }

        if (blob.size > profile.maxBytes) {
          continue
        }

        let dataUrl: string
        try {
          dataUrl = await adapter.readAsDataURL(blob)
        } catch {
          throw invalidImage('Unable to read the processed JPEG.')
        }
        if (!dataUrl.startsWith('data:image/jpeg')) {
          throw invalidImage('The processed output is not a JPEG data URL.')
        }

        let previewUrl: string
        try {
          previewUrl = adapter.createObjectURL(blob)
        } catch {
          throw invalidImage('Unable to create an image preview.')
        }
        let revoked = false

        return {
          blob,
          dataUrl,
          width,
          height,
          previewUrl,
          revoke() {
            if (!revoked) {
              revoked = true
              adapter.revokeObjectURL(previewUrl)
            }
          },
        }
      }

      throw new ImageProcessingError('IMAGE_TOO_LARGE', `The processed JPEG exceeds the ${profile.label} upload limit.`)
    } finally {
      bitmap?.close()
    }
  }
}

/** Creates the overview-photo processor with injectable browser APIs for deterministic tests. */
export function createImageProcessor(adapter: ImageProcessingAdapter) {
  return createConfiguredImageProcessor(adapter, OVERVIEW_PROFILE)
}

/** Creates the lower-budget candidate follow-up processor used for three detail photos. */
export function createCandidateImageProcessor(adapter: ImageProcessingAdapter) {
  return createConfiguredImageProcessor(adapter, CANDIDATE_PROFILE)
}

export async function processImage(file: File): Promise<ProcessedImage> {
  return createImageProcessor(createBrowserAdapter())(file)
}

export async function processCandidateImage(file: File): Promise<ProcessedImage> {
  return createCandidateImageProcessor(createBrowserAdapter())(file)
}
