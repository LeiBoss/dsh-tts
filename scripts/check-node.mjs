#!/usr/bin/env node
/**
 * Fail fast with an actionable message.
 *
 * The tests execute TypeScript directly, which needs Node >= 22.18. Without this
 * guard a contributor on an older Node sees `Could not find 'test/**\/*.test.ts'`
 * and has no idea the runtime is the problem.
 */
const [majorRaw, minorRaw] = process.versions.node.split('.')
const major = Number(majorRaw)
const minor = Number(minorRaw)
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(
    `These packages test and build TypeScript directly, so they need Node >= 22.18 (running ${process.version}).\n` +
      'Use a newer Node, or set it through nvm/fnm before running the tests.\n',
  )
  process.exit(1)
}