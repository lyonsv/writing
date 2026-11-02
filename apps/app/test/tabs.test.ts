import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { NativeLibrary, sha256Hex } from '../src/local/library';
import type { NativeFs } from '../src/local/nativeFs';
import { IdbFs, openMarginDb } from '../src/web/idbFs';

/**
 * Validator M8 MEDIUM: two browser tabs share one IndexedDB library. A sync
 * download in tab A must never overwrite a save that tab B reported as saved,
 * and B's text must always survive (in the file or a conflict copy).
 */
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delays every operation a little, so the two tabs interleave differently each run. */
function jittery(fs: NativeFs, rand: () => number, opts: { atomic: boolean }): NativeFs {
  const wait = () => new Promise((r) => setTimeout(r, Math.floor(rand() * 4)));
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      await wait();
      return fn(...a);
    };
  const out: NativeFs = {
    stat: wrap(fs.stat.bind(fs)),
    list: wrap(fs.list.bind(fs)),
    readBytes: wrap(fs.readBytes.bind(fs)),
    writeAtomic: wrap(fs.writeAtomic.bind(fs)),
    move: wrap(fs.move.bind(fs)),
    mkdir: wrap(fs.mkdir.bind(fs)),
    remove: wrap(fs.remove.bind(fs)),
  };
  if (opts.atomic) {
    out.writeIf = wrap(fs.writeIf!.bind(fs));
    out.moveIf = wrap(fs.moveIf!.bind(fs));
  }
  return out;
}

async function race(seed: number, atomic: boolean) {
  const rand = rng(seed);
  const name = `tabs-${atomic}-${seed}`;
  const tab = async () => new NativeLibrary({ fs: jittery(new IdbFs(await openMarginDb(name)), rand, { atomic }), now: () => new Date(2026, 10, 2, 12, 0) });
  const a = await tab();
  const b = await tab();
  await a.init();
  await b.init();
  await b.save('doc.md', 'v0');
  await b.open('doc.md'); // B's editor has v0
  const [saved, downloaded] = await Promise.all([
    b.save('doc.md', `B's text ${seed}`),
    a.writeForSync('doc.md', enc('remote'), sha256Hex(enc('v0'))),
  ]);
  const fs = new IdbFs(await openMarginDb(name));
  const file = dec(await fs.readBytes('Margin/doc.md'));
  const copies = (await fs.list('Margin')).filter((e) => e.name.includes('(conflict'));
  const copyTexts = await Promise.all(copies.map(async (c) => dec(await fs.readBytes(`Margin/${c.name}`))));
  return { saved, downloaded, file, copyTexts };
}

describe('two tabs on one IndexedDB library', () => {
  it('a download never overwrites a save another tab reported as saved; B’s text always survives', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = await race(seed, true);
      const mine = `B's text ${seed}`;
      if (r.saved.status === 'saved') {
        expect(r.file, `seed ${seed}`).toBe(mine);
        expect(r.downloaded, `seed ${seed}`).toBe(false);
      } else {
        expect(r.saved.status, `seed ${seed}`).toBe('conflict');
        expect(r.copyTexts, `seed ${seed}`).toContain(mine);
        expect(r.file, `seed ${seed}`).toBe('remote');
      }
    }
  });

  it('without the atomic compare-and-write the same race loses a save (the bug this guards)', async () => {
    let lost = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = await race(seed, false);
      const mine = `B's text ${seed}`;
      if (r.file !== mine && !r.copyTexts.includes(mine)) lost++;
    }
    expect(lost).toBeGreaterThan(0);
  });

  it('a change in one tab reaches the other tab’s open editor (externalWrite, as broadcast)', async () => {
    const name = 'tabs-broadcast';
    const a = new NativeLibrary({ fs: new IdbFs(await openMarginDb(name)), onLocalWrite: (p) => b.externalWrite(p) });
    const b: NativeLibrary = new NativeLibrary({ fs: new IdbFs(await openMarginDb(name)) });
    await a.init();
    await b.init();
    await a.save('x.md', 'one');
    await b.open('x.md');
    const seen: string[] = [];
    b.onExternalChange((c) => seen.push(c.content));
    await a.save('x.md', 'two');
    await b.idle();
    expect(seen).toEqual(['two']);
  });
});
