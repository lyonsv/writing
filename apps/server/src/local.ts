import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/**
 * Serves the app on a local port with Node's http server (local dev and
 * integration tests; Vercel doesn't use this). `port: 0` picks a free port.
 */
export function listen(
  app: Hono<never> | { fetch: (req: Request) => Response | Promise<Response> },
  port = 0,
  hostname = '127.0.0.1',
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      resolve({
        url: `http://${hostname}:${info.port}`,
        close: () =>
          new Promise<void>((done) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
