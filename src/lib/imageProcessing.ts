export const IMAGE_MAX_BYTES = 25 * 1024 * 1024
export const PROCESSED_IMAGE_MAX_BYTES = 6 * 1024 * 1024
export const PROCESSED_IMAGE_MAX_EDGE = 2560

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

// Fixed attempts prevent pathological files from causing an unbounded encode loop.
// Preserve full resolution first, then lower JPEG quality, then reduce dimensions.
const COMPRESSION_ATTEMPTS: readonly CompressionAttempt[] = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.72 },
  { scale: 0.8, quality: 0.72 },
  { scale: 0.65, quality: 0.68 },
]

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

/** Creates a processor with injectable browser APIs for deterministic browser tests. */
export function createImageProcessor(adapter: ImageProcessingAdapter) {
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

      const initialScale = Math.min(1, PROCESSED_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
      const baseWidth = scaledDimension(bitmap.width, initialScale)
      const baseHeight = scaledDimension(bitmap.height, initialScale)

      for (const attempt of COMPRESSION_ATTEMPTS) {
        const width = scaledDimension(baseWidth, attempt.scale)
        const height = scaledDimension(baseHeight, attempt.scale)
        let blob: Blob
        try {
          blob = await encodeJpeg(adapter, bitmap, width, height, attempt.quality)
        } catch (error) {
          if (error instanceof ImageProcessingError) throw error
          throw invalidImage('Unable to encode the image as JPEG.')
        }

        if (blob.size > PROCESSED_IMAGE_MAX_BYTES) {
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

      throw new ImageProcessingError('IMAGE_TOO_LARGE', 'The processed JPEG exceeds the 6 MiB upload limit.')
    } finally {
      bitmap?.close()
    }
  }
}

export async function processImage(file: File): Promise<ProcessedImage> {
  return createImageProcessor(createBrowserAdapter())(file)
}
