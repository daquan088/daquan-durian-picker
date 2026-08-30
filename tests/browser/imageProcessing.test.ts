import { parse as parseExif } from 'exifr'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceIdManager, DEVICE_ID_STORAGE_KEY } from '../../src/lib/deviceId'
import {
  IMAGE_MAX_BYTES,
  PROCESSED_IMAGE_MAX_BYTES,
  createImageProcessor,
  type ImageProcessingAdapter,
} from '../../src/lib/imageProcessing'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_UUID = '123e4567-e89b-42d3-b456-426614174000'

function makeFile(bytes: number, type = 'image/png', contents = 'source-image'): File {
  return new File([contents], 'durian.png', { type, lastModified: 0 }) as File & { size: number }
}

function fileWithSize(bytes: number, type = 'image/png'): File {
  return { name: 'durian.png', size: bytes, type } as File
}

function makeAdapter(options: {
  width?: number
  height?: number
  blobs?: Blob[]
  decodeError?: Error
  nullBlob?: boolean
} = {}) {
  const bitmap = {
    width: options.width ?? 4000,
    height: options.height ?? 2000,
    close: vi.fn(),
  }
  const drawImage = vi.fn()
  const canvases: Array<{ width: number; height: number }> = []
  const toBlob = vi.fn((_canvas: unknown, _type: string, _quality: number) => {
    if (options.nullBlob) return Promise.resolve(null)
    return Promise.resolve(options.blobs?.shift() ?? new Blob(['jpeg-output'], { type: 'image/jpeg' }))
  })
  const createObjectURL = vi.fn(() => 'blob:processed-image')
  const revokeObjectURL = vi.fn()
  const adapter: ImageProcessingAdapter = {
    createImageBitmap: options.decodeError
      ? vi.fn().mockRejectedValue(options.decodeError)
      : vi.fn().mockResolvedValue(bitmap),
    createCanvas: vi.fn((width, height) => {
      const canvas = { width, height }
      canvases.push(canvas)
      return {
        canvas,
        context: { drawImage },
      }
    }),
    toBlob,
    createObjectURL,
    revokeObjectURL,
    readAsDataURL: vi.fn(async (blob) => `data:${blob.type};base64,anBlZy1vdXRwdXQ=`),
  }

  return { adapter, bitmap, drawImage, canvases, toBlob, createObjectURL, revokeObjectURL }
}

describe('device identity', () => {
  beforeEach(() => localStorage.clear())

  it('returns an existing canonical v4 UUID unchanged', () => {
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, UUID)
    const randomUUID = vi.fn(() => SECOND_UUID)

    expect(createDeviceIdManager({ randomUUID }).getDeviceId()).toBe(UUID)
    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('generates and persists an ID when none exists, then remains stable', () => {
    const randomUUID = vi.fn(() => UUID)
    const manager = createDeviceIdManager({ randomUUID })

    expect(manager.getDeviceId()).toBe(UUID)
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(UUID)
    expect(manager.getDeviceId()).toBe(UUID)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('replaces an invalid stored ID', () => {
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, 'not-a-uuid')

    expect(createDeviceIdManager({ randomUUID: () => UUID }).getDeviceId()).toBe(UUID)
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(UUID)
  })

  it('uses one in-memory ID for the page session when storage throws SecurityError', () => {
    const randomUUID = vi.fn(() => UUID)
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('blocked', 'SecurityError') }),
    }
    const manager = createDeviceIdManager({ randomUUID, getStorage: () => storage })

    expect(manager.getDeviceId()).toBe(UUID)
    expect(manager.getDeviceId()).toBe(UUID)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('keeps the generated ID when storage only rejects the persistence write', () => {
    const randomUUID = vi.fn(() => UUID)
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new DOMException('blocked', 'SecurityError') }),
    }
    const manager = createDeviceIdManager({ randomUUID, getStorage: () => storage })

    expect(manager.getDeviceId()).toBe(UUID)
    expect(manager.getDeviceId()).toBe(UUID)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })
})

describe('processImage', () => {
  it('rejects a source over 25 MiB before attempting to decode', async () => {
    const setup = makeAdapter()
    const processImage = createImageProcessor(setup.adapter)

    await expect(processImage(fileWithSize(IMAGE_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(setup.adapter.createImageBitmap).not.toHaveBeenCalled()
  })

  it('rejects empty and non-image sources safely', async () => {
    const setup = makeAdapter()
    const processImage = createImageProcessor(setup.adapter)

    await expect(processImage(fileWithSize(0))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(processImage(fileWithSize(1, 'application/pdf'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(setup.adapter.createImageBitmap).not.toHaveBeenCalled()
  })

  it('decodes with EXIF orientation, constrains the longest edge, and encodes a JPEG at 0.85', async () => {
    const setup = makeAdapter({ width: 4000, height: 2000 })
    const processImage = createImageProcessor(setup.adapter)

    const result = await processImage(makeFile(10))

    expect(setup.adapter.createImageBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' })
    expect(result).toMatchObject({ width: 2560, height: 1280 })
    expect(setup.drawImage).toHaveBeenCalledWith(setup.bitmap, 0, 0, 2560, 1280)
    expect(setup.toBlob).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 0.85)
    expect(result.blob.type).toBe('image/jpeg')
    expect(result.dataUrl).toBe('data:image/jpeg;base64,anBlZy1vdXRwdXQ=')
    expect(setup.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('does not upscale a smaller image', async () => {
    const setup = makeAdapter({ width: 640, height: 480 })

    const result = await createImageProcessor(setup.adapter)(makeFile(10))

    expect(result).toMatchObject({ width: 640, height: 480 })
    expect(setup.drawImage).toHaveBeenCalledWith(setup.bitmap, 0, 0, 640, 480)
  })

  it('performs bounded JPEG fallback compression and rejects a still-overlarge output', async () => {
    const overlarge = new Blob([new Uint8Array(PROCESSED_IMAGE_MAX_BYTES + 1)], { type: 'image/jpeg' })
    const setup = makeAdapter({ blobs: [overlarge, overlarge, overlarge, overlarge] })

    await expect(createImageProcessor(setup.adapter)(makeFile(10))).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(setup.toBlob).toHaveBeenCalledTimes(4)
    expect(setup.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('rejects null canvas output and closes the decoded bitmap', async () => {
    const setup = makeAdapter({ nullBlob: true })

    await expect(createImageProcessor(setup.adapter)(makeFile(10))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(setup.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('handles decode failure safely', async () => {
    const setup = makeAdapter({ decodeError: new Error('bad image') })

    await expect(createImageProcessor(setup.adapter)(makeFile(10))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('re-encodes into fresh JPEG bytes without source EXIF/GPS metadata and revokes the preview only once', async () => {
    const sourceMarker = 'GPS-ORIGINAL-DEVICE-METADATA'
    const source = new File([`Exif\u0000\u0000${sourceMarker}`], 'photo.jpg', { type: 'image/jpeg' })
    const cleanJpeg = new Blob([
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ], { type: 'image/jpeg' })
    const setup = makeAdapter({ blobs: [cleanJpeg] })

    const result = await createImageProcessor(setup.adapter)(source)
    const outputText = new TextDecoder().decode(await result.blob.arrayBuffer())

    expect(outputText).not.toContain('Exif')
    expect(outputText).not.toContain(sourceMarker)
    await expect(parseExif(result.blob)).resolves.toBeUndefined()
    result.revoke()
    result.revoke()
    expect(setup.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(setup.revokeObjectURL).toHaveBeenCalledWith('blob:processed-image')
  })
})
