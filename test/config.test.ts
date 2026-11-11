import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'

test('explicit outputDir wins over DSH_HOME', () => {
  const config = resolveConfig(
    { outputDir: '/tmp/explicit-tts' },
    { DSH_HOME: '/tmp/harness-home' },
  )
  assert.equal(config.outputDir, resolve('/tmp/explicit-tts'))
})

test('DSH_HOME/tts-output is used when outputDir is absent', () => {
  const config = resolveConfig({}, { DSH_HOME: '/tmp/harness-home' })
  assert.equal(config.outputDir, resolve('/tmp/harness-home', 'tts-output'))
  assert.equal(config.dshHome, '/tmp/harness-home')
})

test('an unset DSH_HOME falls back to ~/.dsh/tts-output', () => {
  const config = resolveConfig({}, {})
  assert.equal(config.outputDir, join(homedir(), '.dsh', 'tts-output'))
  assert.equal(config.dshHome, '')
  assert.ok(config.outputDir.startsWith('/') || config.outputDir.includes(':'))
})
