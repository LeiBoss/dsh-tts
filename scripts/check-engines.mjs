#!/usr/bin/env node
// Validate that package.json's `engines` can match the DSH runtime we ship for.
//
// The default runtime below must be updated whenever DSH publishes a new
// version; override it with DSH_RUNTIME_VERSION for ad-hoc checks.
//
// This exists because prerelease versions sort below their stable counterpart:
// a range of `>=0.2.2` never matches `0.2.2-rc.1`, which silently rejects every
// installation. CI runs this so the gate cannot regress unnoticed.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const DEFAULT_RUNTIME = '0.2.2-rc.1'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshRange = pkg.engines?.dsh
const nodeRange = pkg.engines?.node
const runtime = process.env.DSH_RUNTIME_VERSION?.trim() || DEFAULT_RUNTIME

if (!dshRange) {
  console.error('engines.dsh is missing from package.json')
  process.exit(1)
}
if (!nodeRange) {
  console.error('engines.node is missing from package.json')
  process.exit(1)
}

if (!semver.satisfies(runtime, dshRange, { includePrerelease: true })) {
  console.error(`engines.dsh=${dshRange} does not match dsh runtime ${runtime}`)
  process.exit(1)
}

if (!semver.satisfies(process.versions.node, nodeRange)) {
  console.error(
    `engines.node=${nodeRange} does not match running node ${process.versions.node}`,
  )
  process.exit(1)
}

console.log(`engines ok: dsh ${runtime} satisfies ${dshRange}`)
