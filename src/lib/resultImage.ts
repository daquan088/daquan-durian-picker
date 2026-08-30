import { toPng } from 'html-to-image'

export const RESULT_IMAGE_FILENAME = '大全助你选金枕榴莲-结果.png'

export type ResultImageExportOutcome = {
  kind: 'shared' | 'fallback' | 'cancelled'
  dataUrl: string
  file: File
  error?: Error
}

export interface ResultImageDependencies {
  toPng?: typeof toPng
  navigator?: Pick<Navigator, 'canShare' | 'share'>
}

function dataUrlToPngFile(dataUrl: string): File {
  const separator = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, separator).toLowerCase()
  const payload = dataUrl.slice(separator + 1)
  if (separator < 0 || !header.startsWith('data:image/png') || !header.includes(';base64')) {
    throw new Error('结果图生成格式无效，请重新生成。')
  }
  const binary = atob(payload)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new File([bytes], RESULT_IMAGE_FILENAME, { type: 'image/png' })
}

function isShareCancellation(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError'
}

/** Captures only the dedicated result card and returns a durable data URL for long-press saving. */
export async function exportResultImage(element: HTMLElement, dependencies: ResultImageDependencies = {}): Promise<ResultImageExportOutcome> {
  const generate = dependencies.toPng ?? toPng
  const shareNavigator = dependencies.navigator ?? navigator
  const dataUrl = await generate(element, { pixelRatio: 2, cacheBust: true })
  const file = dataUrlToPngFile(dataUrl)

  if (!shareNavigator.share || !shareNavigator.canShare) return { kind: 'fallback', dataUrl, file }

  try {
    if (!shareNavigator.canShare({ files: [file] })) return { kind: 'fallback', dataUrl, file }
  } catch {
    return { kind: 'fallback', dataUrl, file }
  }

  try {
    await shareNavigator.share({ files: [file] })
    return { kind: 'shared', dataUrl, file }
  } catch (error) {
    if (isShareCancellation(error)) return { kind: 'cancelled', dataUrl, file }
    return { kind: 'fallback', dataUrl, file, error: error instanceof Error ? error : new Error('分享未完成') }
  }
}
