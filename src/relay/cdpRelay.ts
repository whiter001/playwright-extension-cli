/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * WebSocket server that bridges the CDP client and the Chrome Extension.
 *
 * Endpoints:
 * - /cdp/<guid>    Full CDP interface for the CDP client
 * - /extension/<guid> Extension connection
 *
 * Ported from microsoft/playwright:
 *   packages/playwright-core/src/tools/mcp/cdpRelay.ts
 */

import { log, logUnhandledError } from '../log';
import { ExtensionProtocolV2 } from './relayV2';
import { WSServer } from './wsServer';

import { WebSocket } from 'ws';

import type { RawData } from 'ws';
import type { CDPMessage } from './browserModel';

export type CDPRelayOptions = {
  /** Protocol version advertised to the extension. */
  protocolVersion?: number;
  /** Token that lets the extension skip the manual approval dialog. */
  token?: string;
  /** How long to wait for the extension to connect. 0 = wait forever. */
  connectTimeoutMs?: number;
};

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

/**
 * Raised when the relay is torn down on purpose rather than failing.
 *
 * Callers use this to keep normal shutdown out of the error log.
 */
export class RelayStoppedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RelayStoppedError';
  }
}

export function isRelayStopped(error: unknown): boolean {
  return error instanceof RelayStoppedError;
}

type CDPResponse = CDPMessage;

export class CDPRelayServer {
  private _wsServer: WSServer;
  private _wsHost!: string;
  private _cdpPath: string;
  private _extensionPath: string;
  private _cdpConnection: WebSocket | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _protocolVersion: number;
  private _token?: string;
  private _connectTimeoutMs: number;
  private _handler: ExtensionProtocolV2;
  private _extensionConnectionPromise: Promise<void>;
  private _resolveExtensionConnection!: () => void;
  private _rejectExtensionConnection!: (error: Error) => void;

  constructor(options: CDPRelayOptions = {}) {
    this._protocolVersion = options.protocolVersion ?? 2;
    this._token = options.token;
    this._connectTimeoutMs = options.connectTimeoutMs ?? 0;

    const sendCommand = (method: string, params: any): Promise<any> => {
      if (!this._extensionConnection)
        throw new Error('Extension not connected');
      return this._extensionConnection.send(method, params);
    };
    this._handler = new ExtensionProtocolV2(sendCommand);

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    this._extensionConnectionPromise = new Promise<void>((resolve, reject) => {
      this._resolveExtensionConnection = resolve;
      this._rejectExtensionConnection = reject;
    });
    void this._extensionConnectionPromise.catch(error => {
      if (isRelayStopped(error))
        log.debug('Extension connection closed:', (error as Error).message);
      else
        log.error(error);
    });

    this._wsServer = new WSServer({
      isAllowedPathname: pathname => pathname === this._cdpPath || pathname === this._extensionPath,
      onConnection: (request, url, ws) => {
        log.debug(`New connection to ${url.pathname}`);
        if (url.pathname === this._cdpPath)
          this._handlePlaywrightConnection(ws);
        else
          this._handleExtensionConnection(ws);
      },
    });
  }

  async start(): Promise<void> {
    this._wsHost = await this._wsServer.listen(0, '127.0.0.1');
  }

  /** Endpoint the CDP client connects to. */
  cdpEndpoint(): string {
    return `${this._wsHost}${this._cdpPath}`;
  }

  /** Endpoint the Chrome Extension connects to. */
  extensionEndpoint(): string {
    return `${this._wsHost}${this._extensionPath}`;
  }

  /**
   * Waits until the extension has connected and completed its handshake.
   *
   * Without a token the user has to approve the connection in the browser,
   * which can take arbitrarily long — hence the default of "wait forever".
   */
  async establishExtensionConnection(timeoutMs?: number): Promise<void> {
    log.debug('Establishing extension connection');
    log.debug('Waiting for incoming extension connection');
    const timeout = timeoutMs ?? this._connectTimeoutMs;
    const deadline = timeout ? Date.now() + timeout : 0;
    await raceAgainstDeadline(async () => {
      await this._extensionConnectionPromise;
      await this._handler.ready();
    }, deadline, timeout);
    log.debug('Extension connection established');
  }

  stop(): void {
    this._closeConnections('Server stopped');
    void this._wsServer.close().catch(logUnhandledError);
  }

  private _closeConnections(reason: string) {
    this._closeCDPConnection(reason);
    // Intentional teardown: the rejection this raises must not be reported as
    // a connection failure, or it masks the real reason a session never came
    // up (a token mismatch, a missing extension, ...).
    this._closeExtensionConnection(reason, true);
  }

  private _handlePlaywrightConnection(ws: WebSocket): void {
    if (!this._extensionConnection) {
      log.debug('Rejecting CDP connection: extension not connected');
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._cdpConnection) {
      log.debug('Rejecting second CDP connection');
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP(msg => this._sendToCDPClient(msg));
    ws.on('message', async data => {
      try {
        await this._handlePlaywrightMessage(JSON.parse(data.toString()));
      } catch (error: any) {
        log.debug(`Error while handling CDP message\n${data.toString()}\n`, error);
      }
    });
    ws.on('close', () => {
      this._closeExtensionConnection('CDP client disconnected');
      log.debug('CDP WebSocket closed');
    });
    ws.on('error', error => {
      log.debug('CDP WebSocket error:', error);
    });
    log.debug('CDP client connected');
  }

  private _closeExtensionConnection(reason: string, intentional = false) {
    this._extensionConnection?.close(reason);
    this._rejectExtensionConnection(intentional ? new RelayStoppedError(reason) : new Error(reason));
  }

  private _closeCDPConnection(reason: string) {
    if (this._cdpConnection?.readyState === WebSocket.OPEN)
      this._cdpConnection.close(1000, reason);
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    this._extensionConnection = new ExtensionConnection(ws);
    this._extensionConnection.onclose = reason => {
      log.debug('Extension WebSocket closed:', reason);
      this._handler.onExtensionDisconnect(reason);
      this._closeCDPConnection(`Extension disconnected: ${reason}`);
    };
    this._extensionConnection.onmessage = (method, params) => this._handler.handleExtensionEvent(method, params);
    this._resolveExtensionConnection();
  }

  private async _handlePlaywrightMessage(message: CDPCommand): Promise<void> {
    log.debug(`← CDP: ${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToCDPClient({ id, sessionId, result });
    } catch (e) {
      log.debug('Error in the extension:', e);
      this._sendToCDPClient({
        id,
        sessionId,
        error: { message: (e as Error).message },
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, sessionId: string | undefined): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return {};
      }
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled)
      return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToCDPClient(message: CDPResponse): void {
    log.debug(`→ CDP: ${message.method ?? `response(id=${message.id})`}`);
    this._cdpConnection?.send(JSON.stringify(message));
  }
}

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: Error) => void, error: Error }>();
  private _lastId = 0;

  onmessage?: (method: string, params: any) => void;
  onclose?: (reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
    this._ws.on('close', this._onClose.bind(this));
    this._ws.on('error', this._onError.bind(this));
  }

  async send(method: string, params: any): Promise<any> {
    if (this._ws.readyState !== WebSocket.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message: string) {
    log.debug('Closing extension connection:', message);
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.close(1000, message);
  }

  private _onMessage(data: RawData) {
    const eventData = data.toString();
    let parsedJson: ExtensionResponse;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e: any) {
      log.debug(`Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e: any) {
      log.debug(`Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }

  private _handleParsedMessage(object: ExtensionResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      log.debug('← Extension: unexpected response', object);
    } else {
      this.onmessage?.(object.method!, object.params);
    }
  }

  private _onClose(code: number, reason: Buffer) {
    const message = reason.toString();
    log.debug(`Extension websocket closed: code=${code} reason=${message}`);
    this._dispose();
    this.onclose?.(message);
  }

  private _onError(error: Error) {
    log.debug('Extension websocket error:', error);
  }

  private _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(callback.error);
    this._callbacks.clear();
  }
}

async function raceAgainstDeadline<T>(action: () => Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
  if (!deadline)
    return await action();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Playwright extension did not connect within ${timeoutMs / 1000}s. ` +
      `Check that the extension is installed in the selected Chrome profile, and that ` +
      `PLAYWRIGHT_MCP_EXTENSION_TOKEN (if set) matches the token shown on the extension status page.`
    )), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([action(), timeout]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
