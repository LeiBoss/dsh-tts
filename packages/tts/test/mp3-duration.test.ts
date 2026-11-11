import assert from 'node:assert/strict'
import test from 'node:test'
import { measureMp3 } from '../src/audio/mp3-duration.ts'

/**
 * Build one Layer III frame with the given header fields and payload size.
 * `total` overrides the frame size for the Xing tests, where the declared
 * length is read from the header rather than from the file layout.
 */
function frame(
  version: 3 | 2,
  bitrateIndex: number,
  sampleRateIndex: number,
  total = 0,
  padding = 0,
): Buffer {
  const b1 = 0xe0 | (version << 3) | (0x01 << 1) | 0x01
  const b2 = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1)
  const header = Buffer.from([0xff, b1, b2, 0xc0])
  const factor = version === 3 ? 144 : 72
  const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex] ?? 0
  const sampleRate = (version === 3 ? [44100, 48000, 32000] : [22050, 24000, 16000])[sampleRateIndex] ?? 0
  const length = total > 0 ? total : Math.floor((factor * bitrate * 1000) / sampleRate) + padding
  const body = Buffer.alloc(Math.max(0, length - header.length))
  return Buffer.concat([header, body])
}

/** Concatenate `count` MPEG-2 Layer III 24 kHz / 48 kbit/s mono frames. */
function mpeg2Frames(count: number): Buffer {
  // version 2, bitrate index 6 (48 kbit/s), sample-rate index 1 (24 kHz).
  const one = frame(2, 6, 1)
  return Buffer.concat(Array.from({ length: count }, () => one))
}

test('counts MPEG-2 Layer III frames into an exact duration', () => {
  // 576 samples per frame at 24 kHz: 100 frames == 2400 ms.
  const info = measureMp3(mpeg2Frames(100))
  assert.ok(info)
  assert.equal(info.frames, 100)
  assert.equal(info.sampleRate, 24000)
  assert.equal(info.durationMs, 2400)
})

test('skips an ID3v2 tag before the first frame', () => {
  const id3 = Buffer.alloc(10 + 64)
  id3.write('ID3', 0, 'latin1')
  id3[3] = 0x03
  // Syncsafe size: 64 == 0x40 in the low byte.
  id3[9] = 0x40
  const info = measureMp3(Buffer.concat([id3, mpeg2Frames(50)]))
  assert.ok(info)
  assert.equal(info.frames, 50)
  assert.equal(info.durationMs, 1200)
})

test('honours a Xing frame count instead of walking frames', () => {
  const first = Buffer.alloc(144)
  first[0] = 0xff
  // MPEG-2 (version bits 10), Layer III (01), no CRC: 0xf3.
  first[1] = 0xf3
  first[2] = 0x64
  first[3] = 0xc0
  const tagOffset = 36
  first.write('Xing', tagOffset, 'latin1')
  first.writeUInt32BE(0x01, tagOffset + 4)
  first.writeUInt32BE(500, tagOffset + 8)
  const info = measureMp3(Buffer.concat([first, mpeg2Frames(3)]))
  assert.ok(info)
  assert.equal(info.frames, 500)
  // 500 frames * 576 samples / 24000 Hz == 12000 ms.
  assert.equal(info.durationMs, 12000)
})

test('measures MPEG-1 44.1 kHz 128 kbit/s frames', () => {
  const one = frame(3, 9, 0)
  const info = measureMp3(Buffer.concat(Array.from({ length: 10 }, () => one)))
  assert.ok(info)
  assert.equal(info.frames, 10)
  assert.equal(info.sampleRate, 44100)
  // 10 * 1152 / 44100 s == 261.2 ms
  assert.equal(info.durationMs, 261)
})

test('rejects non-MP3 payloads instead of guessing', () => {
  assert.equal(measureMp3(Buffer.from('not audio at all')), undefined)
  assert.equal(measureMp3(Buffer.alloc(0)), undefined)
  assert.equal(measureMp3(Buffer.from([0xff, 0xfb])), undefined)
})
