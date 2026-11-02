import { encodeBase64 } from '@margin/core';
import { Directory, File, Paths } from 'expo-file-system';
// The SDK 58 object API (File/Directory) writes with `atomically: false` and its
// `move({ overwrite: true })` deletes the target before moving, so neither can
// replace a file atomically. The legacy `writeAsStringAsync` writes with
// `Data.write(options: .atomic)`: Foundation writes a temporary file and
// rename(2)s it over the target. That is the one call we take from the legacy module.
import { EncodingType, writeAsStringAsync } from 'expo-file-system/legacy';

import { FsExistsError, type FsStat, type NativeFs } from './nativeFs';

/** On-disk name from a file:// URI's last segment. */
function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri;
  return decodeURIComponent(trimmed.slice(trimmed.lastIndexOf('/') + 1));
}

/**
 * `NativeFs` over expo-file-system, rooted at the app's documents directory
 * (`Paths.document`, backed up by iOS and private to the app). Paths are
 * relative and pre-validated by `NativeLibrary`.
 */
export class ExpoFs implements NativeFs {
  constructor(private readonly base: Directory = Paths.document) {}

  private segments(path: string): string[] {
    return path.split('/').filter(Boolean);
  }
  private file(path: string): File {
    return new File(this.base, ...this.segments(path));
  }
  private dir(path: string): Directory {
    return path === '' ? this.base : new Directory(this.base, ...this.segments(path));
  }

  async stat(path: string): Promise<FsStat | null> {
    const probe = Paths.info(this.file(path).uri);
    if (!probe.exists) return null;
    if (probe.isDirectory) {
      const info = this.dir(path).info();
      return { kind: 'dir', size: 0, modifiedAt: info.modificationTime ?? 0 };
    }
    const info = this.file(path).info();
    if (!info.exists) return null;
    return { kind: 'file', size: info.size ?? 0, modifiedAt: info.modificationTime ?? 0 };
  }

  async list(path: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }>> {
    const d = this.dir(path);
    if (!d.exists) return [];
    return d.listAsRecords().map((r) => ({ name: nameOf(r.uri), kind: r.isDirectory ? ('dir' as const) : ('file' as const) }));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.file(path).bytes());
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await writeAsStringAsync(this.file(path).uri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
  }

  async move(from: string, to: string): Promise<void> {
    // Synchronous from the existence check to the move: no other JS (none of our
    // own writes, saves or sync) can run in between. Nothing else writes to the
    // app's container. FileManager.moveItem also refuses an existing target itself.
    const src = Paths.info(this.file(from).uri);
    if (!src.exists) throw new Error(`${from} does not exist`);
    if (Paths.info(this.file(to).uri).exists) throw new FsExistsError(to);
    if (src.isDirectory) this.dir(from).moveSync(new Directory(this.base, ...this.segments(to)));
    else this.file(from).moveSync(this.file(to));
  }

  async mkdir(path: string): Promise<void> {
    if (path === '') return;
    this.dir(path).create({ intermediates: true, idempotent: true });
  }

  async remove(path: string): Promise<void> {
    const probe = Paths.info(this.file(path).uri);
    if (!probe.exists) return;
    if (probe.isDirectory) this.dir(path).delete();
    else this.file(path).delete();
  }
}
