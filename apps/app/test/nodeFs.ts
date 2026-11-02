import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FsExistsError, type FsStat, type NativeFs } from '../src/local/nativeFs';

/**
 * `NativeFs` on the real filesystem under `base`, with the same contract as
 * `ExpoFs`: synchronous check-then-move (no replace), atomic writes via temp +
 * rename. `faults` lets tests fail or interleave individual operations.
 */
export class NodeFs implements NativeFs {
  ops: string[] = [];
  /** Throw from the named operation (once per entry) to simulate a crash or I/O error. */
  faults: Array<{ op: keyof NativeFs; match?: (p: string) => boolean; error?: Error }> = [];
  /** Runs before an operation's effect (to interleave other work). */
  before?: (op: keyof NativeFs, p: string) => Promise<void> | void;

  constructor(readonly base: string) {}

  private p(rel: string) {
    return path.join(this.base, ...rel.split('/').filter(Boolean));
  }

  private async hook(op: keyof NativeFs, rel: string) {
    this.ops.push(`${op} ${rel}`);
    await this.before?.(op, rel);
    const i = this.faults.findIndex((f) => f.op === op && (!f.match || f.match(rel)));
    if (i !== -1) {
      const [f] = this.faults.splice(i, 1);
      throw f!.error ?? new Error(`injected ${op} failure`);
    }
  }

  async stat(rel: string): Promise<FsStat | null> {
    try {
      const s = statSync(this.p(rel));
      return { kind: s.isDirectory() ? 'dir' : 'file', size: s.size, modifiedAt: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async list(rel: string) {
    if (!existsSync(this.p(rel))) return [];
    return readdirSync(this.p(rel), { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? ('dir' as const) : ('file' as const) }));
  }

  async readBytes(rel: string) {
    await this.hook('readBytes', rel);
    return new Uint8Array(readFileSync(this.p(rel)));
  }

  async writeAtomic(rel: string, bytes: Uint8Array) {
    await this.hook('writeAtomic', rel);
    const target = this.p(rel);
    const tmp = `${target}.nodefs-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }

  async move(from: string, to: string) {
    await this.hook('move', `${from} -> ${to}`);
    if (!existsSync(this.p(from))) throw new Error(`${from} does not exist`);
    // Like FileManager.moveItem: refuse an existing target. On a case-insensitive
    // volume `to` may "exist" because it is `from` spelled differently.
    try {
      lstatSync(this.p(to));
      throw new FsExistsError(to);
    } catch (error) {
      if (error instanceof FsExistsError) throw error;
    }
    renameSync(this.p(from), this.p(to));
  }

  async mkdir(rel: string) {
    await this.hook('mkdir', rel);
    mkdirSync(this.p(rel), { recursive: true });
  }

  async remove(rel: string) {
    await this.hook('remove', rel);
    rmSync(this.p(rel), { recursive: true, force: true });
  }
}
