import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessLike, SpawnFunction } from '../src/edge-tts.ts'

/** Minimal child-process double with real readable streams. */
export class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kills: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
}

export interface SpawnRecord {
  command: string
  args: string[]
}

function mediaPath(args: readonly string[]): string | undefined {
  const option = args.find((arg) => arg.startsWith('--write-media='))
  return option?.slice('--write-media='.length)
}

/** Spawn double that writes a small audio file and exits successfully. */
export function successfulSpawn(
  calls: SpawnRecord[],
  bytes: Buffer = Buffer.from('ID3fake-mp3-bytes'),
): SpawnFunction {
  return (command, args) => {
    calls.push({ command, args: [...args] })
    const child = new FakeChild()
    queueMicrotask(() => {
      const target = mediaPath(args)
      if (target) writeFileSync(target, bytes)
      child.emit('close', 0, null)
    })
    return child
  }
}

/** Spawn double that exits with `code` after printing to stderr. */
export function failingSpawn(
  calls: SpawnRecord[],
  code: number,
  stderr: string,
): SpawnFunction {
  return (command, args) => {
    calls.push({ command, args: [...args] })
    const child = new FakeChild()
    queueMicrotask(() => {
      child.stderr.write(stderr)
      child.emit('close', code, null)
    })
    return child
  }
}

/** Spawn double that never settles, exercising the timeout path. */
export function hangingSpawn(calls: SpawnRecord[]): {
  spawn: SpawnFunction
  children: FakeChild[]
} {
  const children: FakeChild[] = []
  const spawn: SpawnFunction = (command, args) => {
    calls.push({ command, args: [...args] })
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return { spawn, children }
}

/** Spawn double whose process creation is denied synchronously. */
export function throwingSpawn(code: string): SpawnFunction {
  return () => {
    throw Object.assign(new Error(`spawn edge-tts ${code}`), { code })
  }
}

/** Spawn double that reports an error asynchronously. */
export function erroringSpawn(code: string): SpawnFunction {
  return () => {
    const child = new FakeChild()
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error(`spawn edge-tts ${code}`), { code }))
    })
    return child
  }
}

/** Spawn double that reports a version and exits successfully. */
export function versionSpawn(version: string): SpawnFunction {
  return () => {
    const child = new FakeChild()
    queueMicrotask(() => {
      child.stdout.write(`edge-tts ${version}\n`)
      child.emit('close', 0, null)
    })
    return child
  }
}

/** Build the execution context a tool body receives (only `signal` is used). */
export function executionContext(signal?: AbortSignal) {
  return {
    callId: 'test-call',
    rootCallId: 'test-call',
    name: 'tts_generate',
    arguments: {},
    token: Symbol('test-token'),
    signal: signal ?? new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}
