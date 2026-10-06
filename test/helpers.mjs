import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export class Capture extends EventEmitter {
  chunks = [];
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; this.headersSent = true; }
  setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; }
  write(value) { this.chunks.push(Buffer.from(value)); return true; }
  end(value) { if (value) this.chunks.push(Buffer.from(value)); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

export async function call(handler, config, path, body, options = {}) {
  const request = Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]);
  request.url = path;
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json', 'x-api-key': config.apiKey, ...options.headers };
  const response = new Capture();
  await handler(request, response);
  return response;
}

export function handlerFetch(handler) {
  return async (url, init) => {
    const original = new Request(url, init);
    const request = Readable.from([Buffer.from(await original.arrayBuffer())]);
    request.url = new URL(original.url).pathname;
    request.method = original.method;
    request.headers = Object.fromEntries(original.headers);
    const response = new Capture();
    await handler(request, response);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}
