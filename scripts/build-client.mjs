// Publish the hand-authored client bundle next to the compiled server code.
// The file is written in the Host's module-loader format, so it is copied
// verbatim instead of going through tsc.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'dist', 'client.js')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(join(root, 'client', 'client.js'), target)
