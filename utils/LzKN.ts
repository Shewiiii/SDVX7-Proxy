// @ts-nocheck

import { WriteBuffer } from "./AutoBuffer";

const WINDOW_SIZE = 0x1000;
const WINDOW_MASK = WINDOW_SIZE - 1;
const THRESHOLD = 3;
const INPLACE_THRESHOLD = 0xa;
const LOOK_RANGE = 0x200;
const MAX_LEN = 0xf + THRESHOLD;
const MAX_BUFFER = 0x10 + 1;

function matchCurrent(
    window: Buffer,
    pos: number,
    maxLen: number,
    data: Buffer,
    dpos: number,
): number {
    let len = 0;
    while (
        dpos + len < data.length &&
        len < maxLen &&
        window[(pos + len) & WINDOW_MASK] === data[dpos + len] &&
        len < MAX_LEN
    ) {
        ++len;
    }
    return len;
}

function matchWindow(
    window: Buffer,
    pos: number,
    data: Buffer,
    dpos: number,
): {
    pos: number;
    len: number;
} {
    let maxPos = 0;
    let maxLen = 0;
    for (let i = THRESHOLD; i < LOOK_RANGE; ++i) {
        const len = matchCurrent(
            window,
            (pos - i) & WINDOW_MASK,
            i,
            data,
            dpos,
        );
        if (len >= INPLACE_THRESHOLD) {
            return { pos: i, len };
        }
        if (len >= THRESHOLD) {
            maxPos = i;
            maxLen = len;
        }
    }
    if (maxLen >= THRESHOLD) {
        return { pos: maxPos, len: maxLen };
    }
    return null;
}

function deflate(input: Buffer): Buffer {
    const output = new WriteBuffer(input.length);
    const window = Buffer.alloc(WINDOW_SIZE);
    const buffer = Buffer.alloc(MAX_BUFFER);

    let currentPos = 0;
    let currentWindow = 0;
    let currentBuffer = 0;
    let flagByte = 0;
    let bit = 0;
    let pad = 3;

    while (currentPos < input.length) {
        flagByte = 0;
        currentBuffer = 0;
        for (let bitPos = 0; bitPos < 8; ++bitPos) {
            if (currentPos >= input.length) {
                pad = 0;
                flagByte = flagByte >> (8 - bitPos);
                buffer[currentBuffer] = 0;
                buffer[currentBuffer + 1] = 0;
                currentBuffer += 2;
                break;
            } else {
                const match = matchWindow(
                    window,
                    currentWindow,
                    input,
                    currentPos,
                );
                if (match && match.len >= THRESHOLD) {
                    const byte1 = (match.pos >> 4) & 0xff;
                    const byte2 =
                        (((match.pos & 0x0f) << 4) +
                            ((match.len - THRESHOLD) & 0x0f)) &
                        0xff;
                    buffer[currentBuffer] = byte1;
                    buffer[currentBuffer + 1] = byte2;
                    currentBuffer += 2;
                    bit = 0;

                    for (let _ = 0; _ < match.len; ++_) {
                        window[currentWindow & WINDOW_MASK] = input[currentPos];
                        ++currentPos;
                        ++currentWindow;
                    }
                } else {
                    buffer[currentBuffer] = input[currentPos];
                    window[currentWindow] = input[currentPos];
                    ++currentPos;
                    ++currentWindow;
                    ++currentBuffer;
                    bit = 1;
                }
            }
            flagByte = (flagByte >> 1) | ((bit & 0x1) << 7);
            currentWindow = currentWindow & WINDOW_MASK;
        }
        output.writeByte(flagByte);
        output.writeBytes(buffer.subarray(0, currentBuffer));
        // for (let i = 0; i < currentBuffer; ++i) {
        //     output.writeByte(buffer[i]);
        // }
    }
    output.skip(pad);

    return output.getBuffer();
}

function inflate(data: Buffer): Buffer {
    const result = new WriteBuffer(Math.floor(data.length));
    let cur = 0;
    let byte = 1;
    while (true) {
        if (byte === 1) {
            byte = data[cur++];
            byte |= 0x100;
        }
        const flag = (byte & 0x1) === 1;
        byte >>= 1;
        if (flag) {
            result.writeByte(data[cur++]);
        } else {
            const byte1 = data[cur++];
            const byte2 = data[cur++];
            let len = (byte2 & 0xf) + 3;
            const dist = ((byte1 << 4) & 0x0ff0) | ((byte2 >> 4) & 0x000f);
            if (dist === 0) {
                break;
            }
            while (len > 0) {
                if (result.length - dist < 0) {
                    result.writeByte(0);
                } else {
                    result.writeByte(result.get(result.length - dist));
                }
                --len;
            }
        }
    }

    return result.getBuffer();
}

function deflateDummy(input: Buffer): Buffer {
    const output = new WriteBuffer(input.length * 2);
    const inputLen = input.length;
    for (let i = 0; i < ~~(inputLen / 8); ++i) {
        output.writeByte(0xff);
        for (let j = 0; j < 8; ++j) {
            output.writeByte(input[8 * i + j]);
        }
    }

    if (inputLen % 8 === 0) {
        output.skip(8);
    } else {
        const extra = inputLen % 8;
        output.writeByte(0xff >> (8 - extra));
        for (let i = inputLen - extra; i < inputLen; ++i) {
            output.writeByte(input[i]);
        }
        output.skip(4);
    }

    return output.getBuffer();
}

export default {
    inflate,
    deflate,
    deflateDummy,
};
