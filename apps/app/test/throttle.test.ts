import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SyncHttpRequest } from '@margin/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signInDevice, startMockGitHub, startTestServer } from '../../server/test/mockGitHubHttp';
import { NativeLibrary } from '../src/local/library';
import { NativeSyncService } from '../src/local/sync';
import { NodeFs } from './nodeFs';

/**
 * The web/iOS sync client stays within GitHub's commit budget (ADR 0021
 * amendments): per-path upload throttle by trigger, and Retry-After backoff.
 * Simulated time; the real server app over HTTP.
 */
const OWNER = { login: 'lyonsv', id: 1234567 };
let github: Awaited<ReturnType<typeof startMockGitHub>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  github = await startMockGitHub(OWNER);
  server = await startTestServer(github, OWNER);
});
afterAll(async () => {
  await server.close();
  await github.close();
});

async function client(opts: { busy?: () => number | null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'margin-throttle-'));
  const fs = new NodeFs(dir);
  const library = new NativeLibrary({ fs });
  await library.init();
  const { token } = await signInDevice(server.url, 'web');
  let t = 1_000_000;
  const requests: string[] = [];
  const request: SyncHttpRequest = async (method, pathname, init = {}) => {
    requests.push(`${method} ${pathname}`);
    const busy = opts.busy?.();
    if (busy !== null && busy !== undefined) {
      return new Response('{"error":"busy"}', { status: 503, headers: { 'Retry-After': String(busy) } });
    }
    return fetch(new URL(pathname, server.url), {
      method,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : init.body ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as BodyInit | undefined),
    });
  };
  const sync = new NativeSyncService({
    library,
    fs,
    account: { current: () => ({ state: 'signed-in', serverUrl: server.url, login: 'lyonsv' }), request },
    now: () => t,
    random: () => 0.5,
  });
  return {
    library,
    sync,
    requests,
    advance: (ms: number) => void (t += ms),
    done: () => {
      sync.pause();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const uploadsOf = (requests: string[], doc: string) => requests.filter((r) => r === `PUT /api/sync/file?path=${encodeURIComponent(doc)}`).length;

describe('upload throttle (web and iOS)', () => {
  it('an hour of typing with a pause every 10 s uploads each document at most once a minute (≤ 60), and nothing is lost', async () => {
    const c = await client();
    try {
      for (let i = 0; i < 360; i++) {
        c.advance(10_000);
        await c.library.save('draft.md', `typed up to ${i}`);
        await c.sync.syncNow('scheduled'); // the change nudge after the pause
      }
      const scheduled = uploadsOf(c.requests, 'draft.md');
      expect(scheduled).toBeLessThanOrEqual(60);
      expect(scheduled).toBeGreaterThanOrEqual(55); // it does keep uploading
      // Hiding the page (`flush`) can go every 30 s; Sync (`explicit`) always goes, and carries the latest text.
      await c.library.save('draft.md', 'final words');
      await c.sync.syncNow('explicit');
      expect(uploadsOf(c.requests, 'draft.md')).toBe(scheduled + 1);
      expect(c.sync.lastReport?.uploaded).toEqual(['draft.md']);
    } finally {
      c.done();
    }
  });

  it('flush runs upload a path at most every 30 s; explicit always', async () => {
    const c = await client();
    try {
      let flushUploads = 0;
      for (let i = 0; i < 12; i++) {
        c.advance(10_000); // 2 minutes, a hide every 10 s
        await c.library.save('note.md', `v${i}`);
        await c.sync.syncNow('flush');
      }
      flushUploads = uploadsOf(c.requests, 'note.md');
      expect(flushUploads).toBeLessThanOrEqual(4 + 1); // ≤ one per 30 s over 120 s
      await c.library.save('note.md', 'explicit');
      await c.sync.syncNow('explicit');
      await c.library.save('note.md', 'explicit again');
      await c.sync.syncNow('explicit');
      expect(uploadsOf(c.requests, 'note.md')).toBe(flushUploads + 2);
    } finally {
      c.done();
    }
  });

  it('a 503 with Retry-After pauses syncing quietly for at least that long, even for an explicit sync', async () => {
    let busyFor: number | null = 120;
    const c = await client({ busy: () => busyFor });
    try {
      await c.library.save('a.md', 'text');
      const s = await c.sync.syncNow('explicit');
      expect(s.state).toBe('offline');
      expect(s.message).toBe('Sync paused — retrying in 120 s');
      const before = c.requests.length;
      busyFor = null; // the server recovers, but we wait as asked
      c.advance(60_000);
      expect((await c.sync.syncNow('explicit')).message).toMatch(/^Sync paused — retrying in 60 s$/);
      expect(c.requests.length).toBe(before); // no request while paused
      c.advance(61_000);
      const after = await c.sync.syncNow('scheduled');
      expect(after.state).toBe('idle');
      expect(uploadsOf(c.requests, 'a.md')).toBe(1);
    } finally {
      c.done();
    }
  });

  it('repeated 503s back off further than a short Retry-After', async () => {
    const c = await client({ busy: () => 1 });
    try {
      const first = await c.sync.syncNow('explicit');
      expect(first.message).toBe('Sync paused — retrying in 30 s'); // backoff floor (30 s) beats Retry-After: 1
      c.advance(31_000);
      const second = await c.sync.syncNow('explicit');
      expect(second.message).toBe('Sync paused — retrying in 60 s');
    } finally {
      c.done();
    }
  });
});
