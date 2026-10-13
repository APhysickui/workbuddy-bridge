import { anthropicEvents } from './anthropic.mjs';
import { BridgeError } from './errors.mjs';

export function writeSse(response, event) {
  const value = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return response.write(`${event.event ? `event: ${event.event}\n` : ''}data: ${value}\n\n`);
}

export function startSse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
}

// Thinking is independent of tool transport. It can be displayed
// immediately; tool calls and answer text still wait for final validation.
export class AnthropicThinkingStream {
  constructor(response, id, model, signal) {
    Object.assign(this, { response, id, model, signal });
    this.blocks = new Map();
    this.started = false;
  }

  event(type, fields = {}) { return { event: type, data: { type, ...fields } }; }
  write(type, fields) { writeSse(this.response, this.event(type, fields)); }

  accept(event) {
    if (this.signal.aborted || this.response.destroyed) return;
    if (event.type === 'start') {
      if (event.index !== this.blocks.size || typeof event.thinking !== 'string' || !event.thinking) this.invalid();
      if (!this.started) {
        startSse(this.response);
        this.started = true;
        this.write('message_start', { message: { id: this.id, type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      }
      const block = { index: this.blocks.size, closed: false, thinking: event.thinking, signature: event.signature ?? '' };
      this.blocks.set(event.index, block);
      this.write('content_block_start', { index: block.index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (event.thinking) this.write('content_block_delta', { index: block.index, delta: { type: 'thinking_delta', thinking: event.thinking } });
      if (event.signature) this.write('content_block_delta', { index: block.index, delta: { type: 'signature_delta', signature: event.signature } });
      return;
    }
    const block = this.blocks.get(event.index);
    if (!block || block.closed) return;
    if (event.type === 'delta') {
      block.thinking += event.thinking;
      this.write('content_block_delta', { index: block.index, delta: { type: 'thinking_delta', thinking: event.thinking } });
    }
    if (event.type === 'signature') {
      block.signature += event.signature;
      this.write('content_block_delta', { index: block.index, delta: { type: 'signature_delta', signature: event.signature } });
    }
    if (event.type === 'stop') { this.write('content_block_stop', { index: block.index }); block.closed = true; }
  }

  *finish(result) {
    for (const block of this.blocks.values()) {
      const final = result.content[block.index];
      if (final?.type !== 'thinking' || final.thinking !== block.thinking || (final.signature ?? '') !== block.signature) this.invalid();
      if (!block.closed) yield this.event('content_block_stop', { index: block.index });
    }
    yield* anthropicEvents(this.id, this.model, result, { messageStart: false, skipThinking: this.blocks.size });
  }

  invalid() {
    throw new BridgeError(502, 'upstream_invalid_thinking', 'CLI public thinking does not match the stream order or final content. No completion was accepted.');
  }
}
