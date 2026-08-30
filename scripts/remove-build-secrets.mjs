import { existsSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const buildDirectory = resolve('dist', 'durian_pick_ai_demo')
const copiedDevVars = resolve(buildDirectory, '.dev.vars')

const relativeTarget = relative(buildDirectory, copiedDevVars)
if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
  throw new Error('Refusing to clean a path outside the Worker build directory.')
}

if (existsSync(copiedDevVars)) unlinkSync(copiedDevVars)
if (existsSync(copiedDevVars)) throw new Error('The Worker build still contains .dev.vars.')
