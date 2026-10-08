import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

class LocalResponse extends EventEmitter {
  headers = {};
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;

  constructor(onHeaders) {
    super();
    this.onHeaders = onHeaders;
    this.stream = new ReadableStream({
      start: controller => { this.controller = controller; },
      pull: () => {
        if (this.writableNeedDrain) { this.writableNeedDrain = false; this.emit('drain'); }
      },
      cancel: () => this.destroy()
    }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
  }

  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) {
    this.status = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    this.onHeaders();
  }
  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    this.controller.enqueue(Buffer.from(chunk));
    this.writableNeedDrain = this.controller.desiredSize <= 0;
    return !this.writableNeedDrain;
  }
  end(chunk) {
    if (this.destroyed || this.writableEnded) return;
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.controller.close();
    this.emit('close');
  }
  destroy(error = new Error('Local WorkBuddy response cancelled.')) {
    if (this.destroyed || this.writableEnded) return;
    this.destroyed = true;
    this.controller.error(error);
    this.emit('close');
  }
}

// Resolve fetch on headers and stream bytes as the handler produces them. This
// keeps pi's native thinking events live without a TCP listener or network fetch.
export function createLocalFetch(handler) {
  return async (input, init) => {
    const incoming = new Request(input, init);
    incoming.signal.throwIfAborted();
    const request = Readable.from([Buffer.from(await incoming.arrayBuffer())]);
    const url = new URL(incoming.url);
    request.url = url.pathname + url.search;
    request.method = incoming.method;
    request.headers = Object.fromEntries(incoming.headers);
    return new Promise((resolve, reject) => {
      const response = new LocalResponse(() => resolve(new Response(response.stream, { status: response.status, headers: response.headers })));
      const abort = () => {
        request.emit('aborted');
        response.destroy();
        reject(incoming.signal.reason ?? new Error('Local WorkBuddy request cancelled.'));
      };
      incoming.signal.addEventListener('abort', abort, { once: true });
      if (incoming.signal.aborted) { abort(); incoming.signal.removeEventListener('abort', abort); request.destroy(); return; }
      Promise.resolve().then(() => handler(request, response)).then(() => {
        if (!response.headersSent || (!response.writableEnded && !response.destroyed)) {
          const error = new Error('Local WorkBuddy protocol response did not complete.');
          response.destroy(error);
          reject(error);
        }
      }, error => { response.destroy(error); reject(error); }).finally(() => {
        incoming.signal.removeEventListener('abort', abort);
        request.destroy();
      });
    });
  };
}
