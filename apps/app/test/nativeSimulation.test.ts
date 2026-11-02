import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runSync, type BaseEntry, type SyncLocal, type SyncReport } from '@margin/core';
import { afterAll, describe, expect, it } from 'vitest';

// The core engine's fakes (in-memory server with the real API's semantics, and a fake device).
import { FakeLocal, FakeRemote, enc, sha } from '../../../packages/core/test/syncFakes';
import { NativeLibrary } from '../src/native/library';
import { LibrarySyncLocal } from '../src/native/sync';
import { NodeFs } from './nodeFs';

/**
 * The core randomised two-device simulation (packages/core/test/sync.test.ts),
 * with one device being the iOS adapter over real files (`NativeLibrary` +
 * `LibrarySyncLocal`) and the other the core fake. Asserts convergence and no
 * data loss, with the user editing mid-sync and the other device syncing mid-run.
 */

const base = mkdtempSync(path.join(tmpdir(), 'margin-ios-sim-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Files of a device as path → text; the native device is read from disk. */
interface SimDevice {
  name: string;
  local: SyncLocal;
  base: Map<string, BaseEntry>;
  files(): Map<string, string>;
  /** User edits. The fake applies them immediately; the iPhone queues them like its editor/library UI. */
  set(p: string, text: string, retire: (old: string) => void): Promise<void>;
  del(p: string): Promise<void>;
  mv(from: string, to: string): Promise<void>;
  /** Text kept outside the library that a user can still recover (iOS Recently Deleted). */
  recoverable(): Promise<string[]>;
  /** Set a hook run before the device's sync mutations (user typing mid-sync). */
  beforeMutate(fn: (() => Promise<void>) | undefined): void;
}

function fakeDevice(name: string): SimDevice {
  const local = new FakeLocal();
  return {
    name,
    local,
    base: new Map(),
    files: () => new Map([...local.files].map(([p, b]) => [p, new TextDecoder().decode(b)])),
    set: async (p, t, retire) => {
      const old = local.files.get(p);
      if (old) retire(new TextDecoder().decode(old));
      local.files.set(p, enc(t));
    },
    del: async (p) => void local.files.delete(p),
    mv: async (a, b) => {
      if (!local.files.has(a) || local.files.has(b)) return;
      local.files.set(b, local.files.get(a)!);
      local.files.delete(a);
    },
    recoverable: async () => [],
    beforeMutate: (fn) => {
      local.beforeMutate = fn ? async () => fn() : undefined;
    },
  };
}

async function nativeDevice(name: string, dir: string): Promise<SimDevice> {
  const fs = new NodeFs(dir);
  const library = new NativeLibrary({ fs, now: () => new Date(2026, 10, 2, 12, 0) });
  await library.init();
  const root = path.join(dir, 'Margin');
  const full = (p: string) => path.join(root, p);
  let hook: (() => Promise<void>) | undefined;
  fs.before = async (op) => {
    if (hook && (op === 'writeAtomic' || op === 'move')) {
      const h = hook;
      hook = undefined; // once per sync action, like the core fake's per-mutation hook
      await h();
      hook = h;
    }
  };
  const files = () => {
    const out = new Map<string, string>();
    const walk = (rel: string) => {
      if (!existsSync(path.join(root, rel))) return;
      for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.md')) out.set(p, readFileSync(full(p), 'utf8'));
      }
    };
    walk('');
    return out;
  };
  return {
    name,
    local: new LibrarySyncLocal(library),
    base: new Map(),
    files,
    // User edits go through the library, as the app's editor and library UI do:
    // the editor opens a document and saves it (conflict-checked against what it
    // read), the library UI deletes to Recently Deleted and renames without replacing.
    set: async (p, t, retire) => {
      const doc = await library.open(p);
      retire(doc.content);
      await library.save(p, t);
    },
    del: (p) => library.delete(p).catch(() => undefined),
    mv: (a, b) => library.rename(a, b).catch(() => undefined),
    recoverable: async () => {
      const out: string[] = [];
      for (const t of await library.listTrash()) {
        const f = path.join(dir, '.margin/trash', t.id, 'item');
        if (t.kind === 'document' && existsSync(f)) out.push(readFileSync(f, 'utf8'));
      }
      return out;
    },
    beforeMutate: (fn) => {
      hook = fn;
    },
  };
}

async function simulate(seed: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const remote = new FakeRemote();
  const devices = [await nativeDevice('iPhone', path.join(base, `s${seed}`)), fakeDevice('Mac')];
  const retired = new Set<string>();
  const produced = new Set<string>();
  let n = 0;
  const names = ['a.md', 'b.md', 'notes/c.md', 'notes/d.md', 'e.md'];

  const log: string[] = [];
  const userAct = async (d: SimDevice) => {
    const current = d.files();
    const files = [...current.keys()].filter((p) => names.includes(p) || p.includes('(conflict'));
    const r = rand();
    if (r < 0.45 || files.length === 0) {
      const p = rand() < 0.6 && files.length ? pick(files) : pick(names);
      const text = `${d.name}#${++n}`;
      produced.add(text);
      log.push(`${d.name} set ${p} ${text}`);
      await d.set(p, text, (old) => (log.push(`  retire ${JSON.stringify(old)} at ${p}`), retired.add(old)));
    } else if (r < 0.65) {
      const p = pick(files);
      retired.add(current.get(p)!);
      log.push(`${d.name} del ${p} (${current.get(p)})`);
      await d.del(p);
    } else if (r < 0.8) {
      const from = pick(files);
      const to = pick(names);
      if (!current.has(to)) {
        log.push(`${d.name} mv ${from} ${to}`);
        await d.mv(from, to);
      }
    }
  };

  for (let step = 0; step < 40; step++) {
    const d = pick(devices);
    if (rand() < 0.55) await userAct(d);
    else {
      // The user acts mid-sync. On the iPhone that action queues behind sync's own
      // operation on the same file (not awaited here, or the queue would deadlock).
      // One person does one thing at a time: queued actions run in order.
      let chain = Promise.resolve();
      d.beforeMutate(
        rand() < 0.3
          ? async () => {
              if (rand() < 0.3) chain = chain.then(() => userAct(d));
            }
          : undefined,
      );
      const other = devices.find((x) => x !== d)!;
      let raced = false;
      remote.beforeMutate =
        rand() < 0.2
          ? async () => {
              if (raced) return;
              raced = true;
              remote.beforeMutate = undefined;
              await runSync({ local: other.local, remote, base: other.base, hash: sha });
            }
          : undefined;
      const rep = await runSync({ local: d.local, remote, base: d.base, hash: sha });
      log.push(`${d.name} sync ${JSON.stringify(rep)}`);
      d.beforeMutate(undefined);
      remote.beforeMutate = undefined;
      await chain;
    }
  }

  for (let round = 0; round < 8; round++) {
    const reports: SyncReport[] = [];
    for (const d of devices) reports.push(await runSync({ local: d.local, remote, base: d.base, hash: sha }));
    const changed = (r: SyncReport) =>
      r.uploaded.length + r.downloaded.length + r.conflicts.length + r.deletedLocal.length + r.deletedRemote.length + r.moved.length;
    if (reports.every((r) => r.settled && changed(r) === 0)) break;
  }

  const [phone, mac] = devices.map((d) => Object.fromEntries(d.files())) as [Record<string, string>, Record<string, string>];
  expect(phone, `seed ${seed}: iPhone vs Mac`).toEqual(mac);
  expect(phone, `seed ${seed}: iPhone vs server`).toEqual(remote.snapshot());
  // Text survives in the library, or (deleted on the iPhone) in its Recently Deleted.
  const finalTexts = new Set([...Object.values(phone), ...(await devices[0]!.recoverable())]);
  if (process.env.SIM_DEBUG) console.log(JSON.stringify({ phone, trash: await devices[0]!.recoverable(), retired: [...retired], log }, null, 1));
  for (const text of produced) if (!retired.has(text)) expect(finalTexts.has(text), `seed ${seed}: lost "${text}"`).toBe(true);
}

describe('randomised iPhone (native adapter, real files) + Mac simulation', () => {
  for (let seed = 1; seed <= Number(process.env.SYNC_SEEDS_NATIVE ?? 120); seed++) {
    it(`seed ${seed}`, () => simulate(seed));
  }
});
