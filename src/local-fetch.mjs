import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

class LocalResponse extends EventEmitter {
  chunks = [];
  headers = {};
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

// Feed the real Anthropic SDK through the same protocol handler in this process.
// No TCP listener, HTTP proxy, background daemon or network fetch is involved.
export function createLocalFetch(handler) {
  return async (input, init) => {
    const incoming = new Request(input, init);
    incoming.signal.throwIfAborted();
    const request = Readable.from([Buffer.from(await incoming.arrayBuffer())]);
    const url = new URL(incoming.url);
    request.url = url.pathname + url.search;
    request.method = incoming.method;
    request.headers = Object.fromEntries(incoming.headers);
    const response = new LocalResponse();
    const abort = () => { request.emit('aborted'); response.destroy(); };
    incoming.signal.addEventListener('abort', abort, { once: true });
    try {
      incoming.signal.throwIfAborted();
      await handler(request, response);
      incoming.signal.throwIfAborted();
      if (response.destroyed || !response.writableEnded || !response.status) throw new Error('Local WorkBuddy protocol response did not complete.');
      return new Response(Buffer.concat(response.chunks), { status: response.status, headers: response.headers });
    } finally {
      incoming.signal.removeEventListener('abort', abort);
      request.destroy();
    }
  };
}
