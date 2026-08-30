export const DEVICE_ID_STORAGE_KEY = 'durian-picker-device-id'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface DeviceIdDependencies {
  randomUUID?: () => string
  getStorage?: () => StorageLike | null
}

function browserStorage(): StorageLike | null {
  return globalThis.localStorage
}

function browserRandomUUID(): string {
  return globalThis.crypto.randomUUID()
}

function isCanonicalUuidV4(value: string | null): value is string {
  return value !== null && UUID_V4_PATTERN.test(value)
}

/**
 * Creates a page-scoped device ID accessor. The factory gives tests an isolated
 * in-memory fallback while the exported getter below keeps one fallback ID per page.
 */
export function createDeviceIdManager(dependencies: DeviceIdDependencies = {}) {
  const randomUUID = dependencies.randomUUID ?? browserRandomUUID
  const getStorage = dependencies.getStorage ?? browserStorage
  let inMemoryDeviceId: string | null = null

  const getFallbackId = () => {
    if (inMemoryDeviceId === null) {
      inMemoryDeviceId = randomUUID()
    }
    return inMemoryDeviceId
  }

  return {
    getDeviceId(): string {
      if (inMemoryDeviceId !== null) {
        return inMemoryDeviceId
      }

      let storage: StorageLike | null
      try {
        storage = getStorage()
      } catch {
        return getFallbackId()
      }

      if (storage === null) {
        return getFallbackId()
      }

      let generatedId: string | null = null
      try {
        const existingId = storage.getItem(DEVICE_ID_STORAGE_KEY)
        if (isCanonicalUuidV4(existingId)) {
          return existingId
        }

        generatedId = randomUUID()
        storage.setItem(DEVICE_ID_STORAGE_KEY, generatedId)
        return generatedId
      } catch {
        if (generatedId !== null) {
          inMemoryDeviceId = generatedId
          return generatedId
        }
        return getFallbackId()
      }
    },
  }
}

const pageDeviceIdManager = createDeviceIdManager()

export function getDeviceId(): string {
  return pageDeviceIdManager.getDeviceId()
}
