import { ConfigError, storeConfigFromEnv } from './config.js';
import { GitHubStore } from './githubStore.js';
import { MemoryStore, type KeyValueStore } from './store.js';

/**
 * The storage backend from the environment (ADR 0021): a private GitHub repo
 * (`MARGIN_STORE=github`) or memory (local dev and tests). It never throws at
 * startup: an incomplete configuration yields a store whose every call fails
 * with the ConfigError, and `loadConfig` reports the same error first, so the
 * server answers every request with the generic 500 instead of crashing.
 */
export function storeFromEnv(env: Record<string, string | undefined> = process.env): KeyValueStore {
  try {
    const cfg = storeConfigFromEnv(env);
    if (cfg.kind === 'memory') return new MemoryStore();
    return new GitHubStore({ token: cfg.token, repo: cfg.repo, branch: cfg.branch });
  } catch (error) {
    const fail = async (): Promise<never> => {
      throw error instanceof ConfigError ? error : new ConfigError(String(error));
    };
    return { get: fail, put: fail, delete: fail, list: fail, getBytes: fail, putBytes: fail };
  }
}
