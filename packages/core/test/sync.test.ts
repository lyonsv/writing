import { describe, expect, it } from 'vitest';

import { isSyncablePath, planSync, runSync, type BaseEntry, type LocalFile, type RemoteEntry, type SyncAction, type SyncReport } from '../src';
import { FakeLocal, FakeRemote, enc, sha, shaOf } from './syncFakes';

const H = (s: string) => shaOf(s);
const L = (path: string, s: string): LocalFile => ({ path, hash: H(s), size: s.length });
const R = (path: string, s: string, rev: string, deleted = false): RemoteEntry => ({ path, hash: H(s), size: s.length, rev, updatedAt: '', deleted });
const B = (entries: Record<string, [string, string]>) => new Map<string, BaseEntry>(Object.entries(entries).map(([p, [s, rev]]) => [p, { hash: H(s), rev }]));

describe('planSync: every three-way case', () => {
  const plan = (l: LocalFile[], b: Map<string, BaseEntry>, r: RemoteEntry[]) => planSync(l, b, r, { detectMoves: false });
  const cases: Array<[string, LocalFile[], Map<string, BaseEntry>, RemoteEntry[], SyncAction[]]> = [
    ['in sync', [L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '1')], []],
    ['new local → create-only upload', [L('a.md', 'x')], B({}), [], [{ type: 'upload', path: 'a.md', ifMatch: null }]],
    ['new remote → download into an absent path', [], B({}), [R('a.md', 'x', '1')], [{ type: 'download', path: 'a.md', expectLocal: null }]],
    ['new on both, same content → adopt', [L('a.md', 'x')], B({}), [R('a.md', 'x', '1')], [{ type: 'adopt', path: 'a.md', entry: { hash: H('x'), rev: '1' } }]],
    ['new on both, different → conflict', [L('a.md', 'x')], B({}), [R('a.md', 'y', '1')], [{ type: 'conflict', path: 'a.md' }]],
    ['edited locally → upload if-match base rev', [L('a.md', 'x2')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '1')], [{ type: 'upload', path: 'a.md', ifMatch: '1' }]],
    ['edited remotely → download guarded by base hash', [L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x2', '2')], [{ type: 'download', path: 'a.md', expectLocal: H('x') }]],
    ['deleted locally → delete remote if-match', [], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '1')], [{ type: 'delete-remote', path: 'a.md', ifMatch: '1' }]],
    ['deleted remotely (absent) → delete local guarded', [L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [], [{ type: 'delete-local', path: 'a.md', expectLocal: H('x') }]],
    ['deleted remotely (tombstone) → delete local guarded', [L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '2', true)], [{ type: 'delete-local', path: 'a.md', expectLocal: H('x') }]],
    ['edited on both → conflict', [L('a.md', 'x1')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x2', '2')], [{ type: 'conflict', path: 'a.md' }]],
    ['edited on both to the same text → adopt', [L('a.md', 'x2')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x2', '2')], [{ type: 'adopt', path: 'a.md', entry: { hash: H('x2'), rev: '2' } }]],
    ['edited here, deleted there → re-create (edit wins)', [L('a.md', 'x2')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '2', true)], [{ type: 'upload', path: 'a.md', ifMatch: null }]],
    ['deleted here, edited there → download (edit wins)', [], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x2', '2')], [{ type: 'download', path: 'a.md', expectLocal: null }]],
    ['deleted on both → forget', [], B({ 'a.md': ['x', '1'] }), [], [{ type: 'forget', path: 'a.md' }]],
    ['remote rev bumped with same content → download (cheap, harmless)', [L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '3')], [{ type: 'download', path: 'a.md', expectLocal: H('x') }]],
  ];
  for (const [name, l, b, r, expected] of cases) {
    it(name, () => expect(plan(l, b, r)).toEqual(expected));
  }

  it('never plans a local delete unless local equals the synced base', () => {
    // Local edited, remote deleted: must not delete.
    const actions = plan([L('a.md', 'mine')], B({ 'a.md': ['x', '1'] }), []);
    expect(actions.some((a) => a.type === 'delete-local')).toBe(false);
    // No base at all (fresh device / lost base), remote empty: must not delete.
    expect(plan([L('a.md', 'x')], new Map(), []).some((a) => a.type === 'delete-local')).toBe(false);
  });

  it('detects renames on either side', () => {
    const local = planSync([L('b.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '1')]);
    expect(local).toEqual([{ type: 'move-remote', from: 'a.md', to: 'b.md', ifMatch: '1' }]);
    const remote = planSync([L('a.md', 'x')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '2', true), R('b.md', 'x', '2')]);
    expect(remote).toEqual([{ type: 'move-local', from: 'a.md', to: 'b.md', expectLocal: H('x') }]);
    // A rename plus an edit is not a move: delete + upload.
    expect(planSync([L('b.md', 'x2')], B({ 'a.md': ['x', '1'] }), [R('a.md', 'x', '1')]).map((a) => a.type).sort()).toEqual(['delete-remote', 'upload']);
  });
});

describe('isSyncablePath', () => {
  it('accepts canonical .md paths and refuses everything else', () => {
    for (const ok of ['a.md', 'notes/a b.md', 'é/日本.md', 'A.MD', `${'x'.repeat(252)}.md`]) expect(isSyncablePath(ok), ok).toBe(true);
    for (const bad of ['', 'a.txt', '.a.md', 'x/.git/a.md', '/a.md', 'a//b.md', 'a/', '../a.md', 'a\\b.md', 'a\0.md', 'é.md', `${'x'.repeat(253)}.md`, `${'d/'.repeat(600)}a.md`, 'a\n.md']) {
      expect(isSyncablePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('runSync', () => {
  const setup = () => {
    const remote = new FakeRemote();
    const dev = () => ({ local: new FakeLocal(), base: new Map<string, BaseEntry>() });
    const sync = (d: ReturnType<typeof dev>) => runSync({ local: d.local, remote, base: d.base, hash: sha });
    return { remote, dev, sync };
  };

  it('two devices: different files, same file (conflict keeps both), then converge', async () => {
    const { remote, dev, sync } = setup();
    const a = dev();
    const b = dev();
    a.local.files.set('shared.md', enc('v0'));
    await sync(a);
    await sync(b);
    expect(b.local.snapshot()).toEqual({ 'shared.md': 'v0' });

    a.local.files.set('shared.md', enc('from A'));
    a.local.files.set('a-only.md', enc('A'));
    b.local.files.set('shared.md', enc('from B'));
    b.local.files.set('b-only.md', enc('B'));
    await sync(a);
    const report = await sync(b);
    expect(report.conflicts).toEqual(['shared.md']);
    await sync(a);
    expect(a.local.snapshot()).toEqual(b.local.snapshot());
    expect(a.local.snapshot()).toEqual(remote.snapshot());
    expect(b.local.snapshot()).toEqual({
      'shared.md': 'from A',
      'shared (conflict 2026-11-02 1200).md': 'from B',
      'a-only.md': 'A',
      'b-only.md': 'B',
    });
  });

  it('a user edit landing between plan and download is never overwritten', async () => {
    const { remote, dev, sync } = setup();
    const a = dev();
    const b = dev();
    a.local.files.set('doc.md', enc('v0'));
    await sync(a);
    await sync(b);
    a.local.files.set('doc.md', enc('v1 from A'));
    await sync(a);
    // B's user types just as the download is about to write.
    b.local.beforeMutate = async (p) => {
      if (p === 'doc.md' && !b.local.files.get('doc.md')?.length) return;
      b.local.files.set('doc.md', enc('typed on B'));
      b.local.beforeMutate = undefined;
    };
    await sync(b);
    const snap = b.local.snapshot();
    expect(Object.values(snap).sort()).toEqual(['typed on B', 'v1 from A'].sort());
    expect(remote.snapshot()).toEqual(snap);
  });

  it('a lost base never deletes or overwrites anything', async () => {
    const { remote, dev, sync } = setup();
    const a = dev();
    a.local.files.set('x.md', enc('one'));
    await sync(a);
    a.base.clear();
    a.local.files.set('x.md', enc('two'));
    a.local.files.set('y.md', enc('new'));
    await sync(a);
    const values = Object.values(a.local.snapshot()).sort();
    expect(values).toEqual(['new', 'one', 'two']);
    expect(remote.snapshot()).toEqual(a.local.snapshot());
  });

  it('skips documents the server rejects and reports them', async () => {
    const { remote, dev, sync } = setup();
    const a = dev();
    a.local.files.set('big.md', new Uint8Array(4 * 1024 * 1024 + 1));
    a.local.files.set('ok.md', enc('ok'));
    const report = await sync(a);
    expect(report.rejected).toEqual([{ path: 'big.md', reason: 'too large' }]);
    expect(Object.keys(remote.snapshot())).toEqual(['ok.md']);
    expect(a.local.files.has('big.md')).toBe(true);
  });

  it('renames sync as moves on both sides', async () => {
    const { remote, dev, sync } = setup();
    const a = dev();
    const b = dev();
    a.local.files.set('old.md', enc('text'));
    await sync(a);
    await sync(b);
    a.local.files.set('new.md', a.local.files.get('old.md')!);
    a.local.files.delete('old.md');
    const ra = await sync(a);
    expect(ra.moved).toEqual(['old.md → new.md']);
    const rb = await sync(b);
    expect(rb.moved).toEqual(['old.md → new.md']);
    expect(b.local.snapshot()).toEqual({ 'new.md': 'text' });
    expect(remote.snapshot()).toEqual({ 'new.md': 'text' });
  });
});

// ------------------------------------------------------------------ randomised

/** Small seeded PRNG (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('randomised two-device simulation (no data loss, convergence)', () => {
  /**
   * Every piece of text a user ever produced must survive somewhere in the
   * converged state, unless a user replaced or deleted it *on a device where it
   * was present* (a conscious act). Text that sync overwrote must survive
   * elsewhere: on the server, the other device, or a conflict copy.
   */
  async function simulate(seed: number, opts: { stale?: boolean } = {}) {
    const rand = rng(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const remote = new FakeRemote();
    const devices = ['A', 'B'].map((name) => ({ name, local: new FakeLocal(), base: new Map<string, BaseEntry>() }));
    const retired = new Set<string>();
    const produced = new Set<string>();
    let n = 0;
    const names = ['a.md', 'b.md', 'notes/c.md', 'notes/d.md', 'e.md'];

    const userAct = (d: (typeof devices)[number]) => {
      const files = [...d.local.files.keys()];
      const r = rand();
      if (r < 0.45 || files.length === 0) {
        const path = rand() < 0.6 && files.length ? pick(files) : pick(names);
        const old = d.local.files.get(path);
        if (old) retired.add(new TextDecoder().decode(old));
        const text = `${d.name}#${++n}`;
        produced.add(text);
        d.local.files.set(path, enc(text));
      } else if (r < 0.65) {
        const path = pick(files);
        retired.add(new TextDecoder().decode(d.local.files.get(path)!));
        d.local.files.delete(path);
      } else if (r < 0.8) {
        const from = pick(files);
        const to = pick(names);
        if (!d.local.files.has(to)) {
          d.local.files.set(to, d.local.files.get(from)!);
          d.local.files.delete(from);
        }
      }
    };

    // Stale reads: some manifests come from an older snapshot (lagging replica).
    // Then sync must never trash or overwrite local text on that stale information:
    // every remove must match a server that really deleted the path, every
    // overwrite must write what the server really has now.
    const violations: string[] = [];
    if (opts.stale) {
      remote.serveStale = () => (rand() < 0.3 && remote.history.length ? Math.floor(rand() * remote.history.length) : undefined);
      for (const d of devices) {
        d.local.onDestructive = (kind, path, bytes) => {
          const truth = remote.live(path);
          if (kind === 'remove' && truth) violations.push(`${d.name} trashed ${path} although the server still has it`);
          if (kind === 'overwrite' && truth?.hash !== sha(bytes!)) violations.push(`${d.name} overwrote ${path} with a non-current version`);
        };
      }
    }

    for (let step = 0; step < 60; step++) {
      const d = pick(devices);
      if (rand() < 0.55) userAct(d);
      else {
        // Sometimes the user keeps typing while sync runs.
        d.local.beforeMutate = rand() < 0.3 ? async () => (rand() < 0.3 ? userAct(d) : undefined) : undefined;
        // Sometimes the other device syncs mid-run (not in stale mode, where the
        // destructive-action check compares against the server's state at that instant).
        const other = devices.find((x) => x !== d)!;
        let raced = false;
        remote.beforeMutate =
          !opts.stale && rand() < 0.2
            ? async () => {
                if (raced) return;
                raced = true;
                remote.beforeMutate = undefined;
                await runSync({ local: other.local, remote, base: other.base, hash: sha });
              }
            : undefined;
        await runSync({ local: d.local, remote, base: d.base, hash: sha });
        d.local.beforeMutate = undefined;
        remote.beforeMutate = undefined;
      }
    }

    remote.serveStale = undefined;
    expect(violations, `seed ${seed}`).toEqual([]);
    // Quiesce: no more user activity; sync until both settle.
    for (let round = 0; round < 8; round++) {
      const reports: SyncReport[] = [];
      for (const d of devices) reports.push(await runSync({ local: d.local, remote, base: d.base, hash: sha }));
      if (process.env.SYNC_DEBUG) console.log('round', round, JSON.stringify(reports), JSON.stringify(devices.map((d) => [d.name, d.local.snapshot(), Object.fromEntries(d.base)])), JSON.stringify(remote.snapshot()));
      const changed = (r: SyncReport) =>
        r.uploaded.length + r.downloaded.length + r.conflicts.length + r.deletedLocal.length + r.deletedRemote.length + r.moved.length;
      if (reports.every((r) => r.settled && changed(r) === 0)) break;
    }

    const [a, b] = devices as [(typeof devices)[0], (typeof devices)[0]];
    expect(a.local.snapshot(), `seed ${seed}: A vs B`).toEqual(b.local.snapshot());
    expect(a.local.snapshot(), `seed ${seed}: A vs server`).toEqual(remote.snapshot());
    const finalTexts = new Set(Object.values(a.local.snapshot()));
    for (const text of produced) {
      if (!retired.has(text)) expect(finalTexts.has(text), `seed ${seed}: lost "${text}"`).toBe(true);
    }
  }

  for (let seed = 1; seed <= Number(process.env.SYNC_SEEDS ?? 300); seed++) {
    it(`seed ${seed}`, () => simulate(seed));
  }

  // Validator M5 MAJOR 1: stale manifests must never trash or overwrite newer text.
  for (let seed = 1; seed <= Number(process.env.SYNC_SEEDS ?? 300); seed++) {
    it(`seed ${seed} with stale manifests`, () => simulate(seed, { stale: true }));
  }
});

describe('stale reads and rollbacks (validator M5 MAJOR 1)', () => {
  it('planner: an older rev than the base is stale, never a download or delete', () => {
    const base = B({ 'a.md': ['new', '5'] });
    expect(planSync([L('a.md', 'new')], base, [R('a.md', 'old', '3')], { remoteSeq: 9 })).toEqual([{ type: 'stale', path: 'a.md', reason: 'older-rev' }]);
    expect(planSync([L('a.md', 'new')], base, [R('a.md', 'old', '3', true)], { remoteSeq: 9 })).toEqual([{ type: 'stale', path: 'a.md', reason: 'older-rev' }]);
  });

  it('planner: missing from a manifest that is not newer than the base is stale; from a newer one it is a delete', () => {
    const base = B({ 'a.md': ['x', '5'], 'b.md': ['y', '4'] });
    const remote = [R('b.md', 'y', '4')];
    expect(planSync([L('a.md', 'x'), L('b.md', 'y')], base, remote, { remoteSeq: 5 })).toEqual([{ type: 'stale', path: 'a.md', reason: 'missing-before-seq' }]);
    // seq moved past our base: the entry (and its tombstone) can legitimately be gone.
    expect(planSync([L('a.md', 'x'), L('b.md', 'y')], base, remote, { remoteSeq: 12 })).toEqual([{ type: 'delete-local', path: 'a.md', expectLocal: H('x') }]);
  });

  it('planner: a whole manifest older than the base (rollback) plans nothing but stale', () => {
    const base = B({ 'a.md': ['x', '7'], 'b.md': ['y', '2'] });
    const actions = planSync([L('a.md', 'x2'), L('c.md', 'new')], base, [R('a.md', 'x', '1')], { remoteSeq: 3 });
    expect(actions.every((a) => a.type === 'stale')).toBe(true);
    expect(actions.map((a) => (a.type === 'stale' ? a.path : ''))).toEqual(['a.md', 'b.md']);
  });

  it('a server restored from an old backup trashes and overwrites nothing, and reports it', async () => {
    const remote = new FakeRemote();
    const a = { local: new FakeLocal(), base: new Map<string, BaseEntry>() };
    a.local.files.set('kept.md', enc('v1'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    const backup = remote.history.length - 1;
    a.local.files.set('kept.md', enc('v2'));
    a.local.files.set('later.md', enc('written after the backup'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    expect(Object.keys(remote.snapshot()).sort()).toEqual(['kept.md', 'later.md']);

    remote.rollbackTo(backup); // later.md vanishes, kept.md goes back to v1, seq goes back
    const before = a.local.snapshot();
    const report = await runSync({ local: a.local, remote, base: a.base, hash: sha });
    expect(a.local.snapshot()).toEqual(before); // nothing trashed or overwritten
    expect(report.stale.length).toBeGreaterThan(0);
    expect(report.downloaded.concat(report.deletedLocal, report.uploaded)).toEqual([]);
    expect(report.settled).toBe(false);
  });

  it('a stale body (older rev than the base) is never written locally', async () => {
    const remote = new FakeRemote();
    const a = { local: new FakeLocal(), base: new Map<string, BaseEntry>() };
    a.local.files.set('doc.md', enc('v1'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    a.local.files.set('doc.md', enc('v2'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    // Pretend the base saw an even newer rev (e.g. another device), so the server's body is older.
    a.base.set('doc.md', { hash: sha(enc('v2')), rev: '999' });
    const report = await runSync({ local: a.local, remote, base: a.base, hash: sha });
    expect(a.local.snapshot()).toEqual({ 'doc.md': 'v2' });
    expect(report.stale.map((s) => s.path)).toEqual(['doc.md']);
  });
});

describe('a stale-looking manifest is re-read once, bypassing caches (validator MINOR)', () => {
  it('a stale cached manifest causes no error: the fresh re-read wins', async () => {
    const remote = new FakeRemote();
    const a = { local: new FakeLocal(), base: new Map<string, BaseEntry>() };
    a.local.files.set('x.md', enc('v1'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    const old = remote.history.length - 1;
    a.local.files.set('x.md', enc('v2'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    remote.serveStale = () => old; // a cache keeps serving the older manifest
    const report = await runSync({ local: a.local, remote, base: a.base, hash: sha });
    expect(report.stale).toEqual([]);
    expect(report.settled).toBe(true);
    expect(remote.freshReads).toBe(1);
    expect(a.local.snapshot()).toEqual({ 'x.md': 'v2' });
  });

  it('a real rollback is still reported after the fresh re-read', async () => {
    const remote = new FakeRemote();
    const a = { local: new FakeLocal(), base: new Map<string, BaseEntry>() };
    a.local.files.set('x.md', enc('v1'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    const old = remote.history.length - 1;
    a.local.files.set('x.md', enc('v2'));
    await runSync({ local: a.local, remote, base: a.base, hash: sha });
    remote.serveStale = () => old;
    remote.staleEvenWhenFresh = true;
    const report = await runSync({ local: a.local, remote, base: a.base, hash: sha });
    expect(report.stale.map((x) => x.path)).toEqual(['x.md']);
    expect(remote.freshReads).toBe(1);
    expect(a.local.snapshot()).toEqual({ 'x.md': 'v2' });
  });
});
