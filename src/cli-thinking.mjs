// Read only public thinking blocks from the CLI protocol. Provider metadata,
// debug output and opaque redacted payloads are deliberately not interpreted.
export class CliThinking {
  constructor(onThinking) {
    this.onThinking = onThinking;
    this.partial = [];
    this.complete = [];
    this.open = new Map();
  }

  read(value) {
    if (value?.parent_tool_use_id != null) return;
    if (value?.type === 'assistant' && Array.isArray(value.message?.content)) {
      for (const block of value.message.content) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          this.complete.push({ type: 'thinking', thinking: block.thinking,
            signature: typeof block.signature === 'string' ? block.signature : '' });
        }
      }
      return;
    }
    if (value?.type !== 'stream_event') return;
    const event = value.event;
    if (event?.type === 'message_start') this.open.clear();
    if (!Number.isSafeInteger(event?.index) || event.index < 0) return;
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      const block = { type: 'thinking', thinking: '', signature: '', emitted: false, index: this.partial.length };
      this.partial.push(block);
      this.open.set(event.index, block);
      this.append(block, 'signature', event.content_block.signature);
      this.append(block, 'thinking', event.content_block.thinking);
    } else {
      const block = this.open.get(event.index);
      if (!block) return;
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta') this.append(block, 'thinking', event.delta.thinking);
        if (event.delta?.type === 'signature_delta') this.append(block, 'signature', event.delta.signature);
      } else if (event.type === 'content_block_stop') {
        if (block.emitted) this.onThinking?.({ type: 'stop', index: block.index });
        this.open.delete(event.index);
      }
    }
  }

  append(block, field, value) {
    if (typeof value !== 'string' || !value) return;
    block[field] += value;
    if (!block.emitted && block.thinking) {
      block.emitted = true;
      this.onThinking?.({ type: 'start', index: block.index, thinking: block.thinking, signature: block.signature });
    } else if (block.emitted) this.onThinking?.({ type: field === 'thinking' ? 'delta' : 'signature', index: block.index, [field]: value });
  }

  blocks() {
    // stream-json repeats partial content in assistant snapshots. Use one source
    // so the client transcript contains each public thinking block only once.
    const partial = this.partial.filter(block => block.thinking).map(({ thinking, signature }) => ({ type: 'thinking', thinking, signature }));
    return partial.length ? partial : this.complete;
  }
}
