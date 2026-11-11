/**
 * Pure-JS MP3 timing, so duration and subtitle alignment never depend on
 * ffmpeg or an external probe. Edge-TTS writes `audio-24khz-*` MPEG-2 Layer III
 * (576 samples per frame), but the parser covers MPEG-1/2/2.5 Layer III.
 *
 * Cache metadata and the manifest both promise a `timingQuality`, so a parse
 * failure must be reported as "unknown", never guessed here.
 */
/** MPEG-1 Layer III bitrates in kbit/s, indexed by the 4-bit field. */
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
/** MPEG-2 and MPEG-2.5 Layer III bitrates in kbit/s. */
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
/** Sample rates by MPEG version bits: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5. */
const SAMPLE_RATES = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
};
/** Samples per frame for Layer III, by MPEG version. */
const SAMPLES_PER_FRAME = { 3: 1152, 2: 576, 0: 576 };
/** Read a 28-bit ID3v2 syncsafe integer. */
function syncsafe(b, offset) {
    return (((b[offset] ?? 0) & 0x7f) * 0x200000 +
        ((b[offset + 1] ?? 0) & 0x7f) * 0x4000 +
        ((b[offset + 2] ?? 0) & 0x7f) * 0x80 +
        ((b[offset + 3] ?? 0) & 0x7f));
}
/** Byte offset of the first audio frame, skipping ID3v2 tags and their footer. */
function firstFrameOffset(b) {
    if (b.length < 10)
        return 0;
    if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33)
        return 0;
    const flags = b[5] ?? 0;
    const size = syncsafe(b, 6);
    const footer = (flags & 0x10) !== 0 ? 10 : 0;
    return Math.min(b.length, 10 + size + footer);
}
/** Decode a Layer III frame header, or return undefined when it is not one. */
function readHeader(b, offset) {
    if (offset + 4 > b.length)
        return undefined;
    if (b[offset] !== 0xff)
        return undefined;
    const b1 = b[offset + 1] ?? 0;
    if ((b1 & 0xe0) !== 0xe0)
        return undefined;
    const version = (b1 >> 3) & 0x03;
    const layer = (b1 >> 1) & 0x03;
    // Layer III only: layer bits 01.
    if (layer !== 0x01)
        return undefined;
    if (version === 1)
        return undefined;
    const b2 = b[offset + 2] ?? 0;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    const bitrateTable = version === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3;
    const bitrate = (bitrateTable[bitrateIndex] ?? 0) * 1000;
    const rates = SAMPLE_RATES[version];
    const sampleRate = rates?.[sampleRateIndex] ?? 0;
    const samplesPerFrame = SAMPLES_PER_FRAME[version] ?? 0;
    if (bitrate <= 0 || sampleRate <= 0 || samplesPerFrame <= 0)
        return undefined;
    // Layer III uses 144 (MPEG-1) or 72 (MPEG-2/2.5) as the frame-length factor.
    const factor = version === 3 ? 144 : 72;
    const frameLength = Math.floor((factor * bitrate) / sampleRate) + padding;
    if (frameLength < 24)
        return undefined;
    return { frameLength, sampleRate, samplesPerFrame, bitrate, version };
}
/** Find `Xing`/`Info` in the first frame and read its declared frame count. */
function readXingFrames(b, start, header) {
    const limit = Math.min(b.length - 12, start + header.frameLength);
    for (let i = start + 4; i <= limit; i += 1) {
        const isXing = b[i] === 0x58 && b[i + 1] === 0x69 && b[i + 2] === 0x6e && b[i + 3] === 0x67;
        const isInfo = b[i] === 0x49 && b[i + 1] === 0x6e && b[i + 2] === 0x66 && b[i + 3] === 0x6f;
        if (!isXing && !isInfo)
            continue;
        const flags = b.readUInt32BE(i + 4);
        // Frame count is the first optional field, present when bit 0 is set.
        if ((flags & 0x01) === 0)
            return undefined;
        const frames = b.readUInt32BE(i + 8);
        return frames > 0 ? frames : undefined;
    }
    return undefined;
}
/**
 * Measure an MP3 buffer by walking its frames. Returns undefined for anything
 * that is not a Layer III stream this parser understands, so callers can fall
 * back to an explicit "estimated" timing quality instead of silently lying.
 */
export function measureMp3(buffer) {
    if (buffer.length < 4)
        return undefined;
    const start = firstFrameOffset(buffer);
    const header = readHeader(buffer, start);
    if (header === undefined)
        return undefined;
    const declared = readXingFrames(buffer, start, header);
    if (declared !== undefined) {
        return {
            frames: declared,
            sampleRate: header.sampleRate,
            durationMs: Math.round((declared * header.samplesPerFrame * 1000) / header.sampleRate),
        };
    }
    let offset = start;
    let frames = 0;
    while (offset + 4 <= buffer.length) {
        const current = readHeader(buffer, offset);
        if (current === undefined) {
            // Resync: ID3 padding or a damaged frame. Scan a bounded window so a
            // corrupt tail cannot turn into an O(n^2) walk.
            let resynced = false;
            for (let scan = offset + 1; scan < Math.min(buffer.length - 4, offset + 4096); scan += 1) {
                if (readHeader(buffer, scan) !== undefined) {
                    offset = scan;
                    resynced = true;
                    break;
                }
            }
            if (!resynced)
                break;
            continue;
        }
        frames += 1;
        offset += current.frameLength;
    }
    if (frames === 0)
        return undefined;
    return {
        frames,
        sampleRate: header.sampleRate,
        durationMs: Math.round((frames * header.samplesPerFrame * 1000) / header.sampleRate),
    };
}
//# sourceMappingURL=mp3-duration.js.map