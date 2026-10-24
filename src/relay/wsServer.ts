/**
 * Minimal WebSocket server with path-based routing.
 *
 * Replaces the internal `WSServer` helper used by upstream playwright-mcp
 * (packages/playwright-core/src/utils/wsServer.ts) so this CLI does not have
 * to reach into playwright-core internals.
 *
 * The server deliberately binds to the loopback interface: the Playwright
 * Extension refuses to talk to a relay URL whose host is not 127.0.0.1 or
 * [::1].
 */

import http from 'http';

import { WebSocketServer } from 'ws';

import type { IncomingMessage, Server } from 'http';
import type { WebSocket } from 'ws';

export type WSServerOptions = {
  /** Only connections whose pathname passes this check are upgraded. */
  isAllowedPathname: (pathname: string) => boolean;
  /** Called for every accepted WebSocket connection. */
  onConnection: (request: IncomingMessage, url: URL, ws: WebSocket) => void;
};

export class WSServer {
  private _options: WSServerOptions;
  private _httpServer: Server;
  private _wss: WebSocketServer;
  private _host = '127.0.0.1';
  private _port = 0;

  constructor(options: WSServerOptions) {
    this._options = options;
    this._wss = new WebSocketServer({ noServer: true });
    this._httpServer = http.createServer((request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this._httpServer.on('upgrade', (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '/', `http://${this._host}`);
      } catch {
        socket.destroy();
        return;
      }
      if (!this._options.isAllowedPathname(url.pathname)) {
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(request, socket, head, ws => {
        this._options.onConnection(request, url, ws);
      });
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this._host = host;
    await new Promise<void>((resolve, reject) => {
      this._httpServer.once('error', reject);
      this._httpServer.listen(port, host, () => {
        this._httpServer.removeListener('error', reject);
        resolve();
      });
    });
    const address = this._httpServer.address();
    this._port = typeof address === 'object' && address ? address.port : port;
    return this.host();
  }

  host(): string {
    return `ws://${this._host}:${this._port}`;
  }

  async close(): Promise<void> {
    for (const client of this._wss.clients)
      client.terminate();
    this._wss.close();
    await new Promise<void>(resolve => this._httpServer.close(() => resolve()));
  }
}
