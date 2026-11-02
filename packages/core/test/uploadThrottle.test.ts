import { describe, expect, it } from 'vitest';

import { UPLOAD_MIN_INTERVAL_MS, UploadThrottle, runSync, strongerTrigger, type BaseEntry } from '../src';
import { FakeLocal, FakeRemote, enc, sha } from './syncFakes';

describe('UploadThrottle', () => {
  it('per path: scheduled ≥ 60 s, flush ≥ 30 s, explicit always', () => {
    let t = 0;
    const th = new UploadThrottle(() => t);
    expect(th.allows('a.md', 'scheduled')).toBe(true); // never uploaded
    th.uploaded('a.md');
    expect(th.allows('a.md', 'scheduled')).toBe(false);
    expect(th.allows('a.md', 'flush')).toBe(false);
    expect(th.allows('a.md', 'explicit')).toBe(true);
    expect(th.allows('b.md', 'scheduled')).toBe(true); // other paths unaffected
    t = 30_000;
    expect(th.allows('a.md', 'flush')).toBe(true);
    expect(th.allows('a.md', 'scheduled')).toBe(false);
    expect(th.dueIn(['a.md', 'b.md'])).toBe(30_000);
    t = 60_000;
    expect(th.allows('a.md', 'scheduled')).toBe(true);
    expect(th.dueIn(['a.md'])).toBe(0);
  });

  it('merges triggers to the stronger one', () => {
    expect(strongerTrigger('scheduled', 'flush')).toBe('flush');
    expect(strongerTrigger('explicit', 'flush')).toBe('explicit');
    expect(strongerTrigger('scheduled', 'scheduled')).toBe('scheduled');
  });
});

describe('runSync with a throttle', () => {
  it('holds a throttled upload (base untouched, not settled) and sends it once due', async () => {
    let t = 0;
    const th = new UploadThrottle(() => t);
    const remote = new FakeRemote();
    const local = new FakeLocal();
    const base = new Map<string, BaseEntry>();
    const run = (trigger: 'scheduled' | 'flush' | 'explicit') =>
      runSync({ local, remote, base, hash: sha, allowUpload: (p) => th.allows(p, trigger), onUploaded: (p) => th.uploaded(p) });

    local.files.set('doc.md', enc('v1'));
    expect((await run('scheduled')).uploaded).toEqual(['doc.md']);
    local.files.set('doc.md', enc('v2'));
    const held = await run('scheduled');
    expect(held.held).toEqual(['doc.md']);
    expect(held.settled).toBe(false);
    expect(base.get('doc.md')!.hash).toBe(sha(enc('v1')));
    expect(remote.snapshot()).toEqual({ 'doc.md': 'v1' });
    // Explicit (Sync Now / quit) always goes.
    expect((await run('explicit')).uploaded).toEqual(['doc.md']);
    local.files.set('doc.md', enc('v3'));
    t += 60_000;
    expect((await run('scheduled')).uploaded).toEqual(['doc.md']);
    expect(remote.snapshot()).toEqual({ 'doc.md': 'v3' });
  });

  it('an editor pausing every 10 s for an hour uploads that document at most 60 times (was ~360)', async () => {
    let t = 0;
    const th = new UploadThrottle(() => t);
    const remote = new FakeRemote();
    const local = new FakeLocal();
    const base = new Map<string, BaseEntry>();
    let uploads = 0;
    for (let i = 0; i < 360; i++) {
      local.files.set('doc.md', enc(`edit ${i}`));
      t += 10_000;
      const r = await runSync({ local, remote, base, hash: sha, allowUpload: (p) => th.allows(p, 'scheduled'), onUploaded: (p) => th.uploaded(p) });
      uploads += r.uploaded.length;
    }
    expect(uploads).toBeLessThanOrEqual(60);
    expect(uploads).toBeGreaterThanOrEqual(59);
    expect(UPLOAD_MIN_INTERVAL_MS.scheduled).toBe(60_000);
  });
});
