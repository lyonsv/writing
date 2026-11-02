import { describe, expect, it } from 'vitest';

import { decodeBase64, decodeLatin1, decodeUtf8, encodeBase64, encodeUtf8, toHex } from '../src';

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const nodeDecode = (b: Uint8Array): string | null => {
  try {
    return strict.decode(b);
  } catch {
    return null;
  }
};

describe('byte codecs (no DOM/Node globals; used on iOS)', () => {
  it('encodeUtf8 matches TextEncoder, including astral and lone surrogates', () => {
    const rand = rng(7);
    const samples = ['', 'plain', 'é ß ﬀ ǅ', '日本語', '🙂👩‍👩‍👧', '﻿bom', 'lone \uD800 x', 'tail \uDC00', '\u0000\u007f\u0080߿ࠀ￿'];
    for (let i = 0; i < 500; i++) {
      let s = '';
      for (let k = 0; k < 20; k++) s += String.fromCharCode(Math.floor(rand() * 0x10000));
      samples.push(s);
    }
    for (const s of samples) expect([...encodeUtf8(s)], JSON.stringify(s)).toEqual([...new TextEncoder().encode(s)]);
  });

  it('decodeUtf8 agrees with a fatal TextDecoder on random and malformed bytes', () => {
    const rand = rng(11);
    const cases: Uint8Array[] = [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), // BOM kept
      new Uint8Array([0xc0, 0x80]), // overlong
      new Uint8Array([0xe0, 0x80, 0x80]),
      new Uint8Array([0xed, 0xa0, 0x80]), // surrogate
      new Uint8Array([0xf4, 0x90, 0x80, 0x80]), // > U+10FFFF
      new Uint8Array([0xe2, 0x82]), // truncated
      new Uint8Array([0xff]),
      new TextEncoder().encode('ok 🙂 日本'),
    ];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rand() * 12);
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k++) b[k] = rand() < 0.5 ? Math.floor(rand() * 0x80) : 0x80 + Math.floor(rand() * 0x80);
      cases.push(b);
    }
    for (const b of cases) expect(decodeUtf8(b), toHex(b)).toBe(nodeDecode(b));
  });

  it('decodes large text without blowing the stack', () => {
    const big = 'é'.repeat(300_000);
    expect(decodeUtf8(encodeUtf8(big))).toBe(big);
  });

  it('base64 round-trips and matches Buffer', () => {
    const rand = rng(3);
    for (let len = 0; len < 200; len++) {
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k++) b[k] = Math.floor(rand() * 256);
      const s = encodeBase64(b);
      expect(s).toBe(Buffer.from(b).toString('base64'));
      expect([...decodeBase64(s)]).toEqual([...b]);
    }
    expect(() => decodeBase64('ab$c')).toThrow();
  });

  it('latin1 maps one char per byte', () => {
    expect(decodeLatin1(new Uint8Array([0x61, 0xe9, 0xff]))).toBe('aéÿ');
  });
});
