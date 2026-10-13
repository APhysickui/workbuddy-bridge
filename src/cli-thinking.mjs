import { BridgeError } from './errors.mjs';

// Read only public thinking blocks. Generation IDs and block order associate
// partial events with snapshots; equal text in separate generations is distinct.
export class CliThinking {
  constructor(onThinking) {
    this.onThinking = onThinking;
    this.generations = new Map();
    this.public = [];
  }

  generation(id) {
    const generation = { id, slots: [], byIndex: new Map(), snapshots: new Map(), partial: false };
    if (id) this.generations.set(id, generation);
    return generation;
  }

  read(value) {
    if (value?.parent_tool_use_id != null) return;
    if (value?.type === 'result') { this.finish(); return; }
    if (value?.type === 'assistant' && Array.isArray(value.message?.content)) {
      this.snapshot(value);
      return;
    }
    if (value?.type !== 'stream_event') return;
    const event = value.event;
    if (event?.type === 'message_start') {
      this.finish();
      this.current = this.generations.get(event.message?.id) ?? this.generation(event.message?.id);
      this.current.partial = true;
      return;
    }
    if (!Number.isSafeInteger(event?.index) || event.index < 0) return;
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      this.current ??= this.generation();
      this.current.partial = true;
      const block = this.newBlock(this.current);
      this.current.byIndex.set(event.index, block);
      this.append(block, 'signature', event.content_block.signature);
      this.append(block, 'thinking', event.content_block.thinking);
    } else {
      const block = this.current?.byIndex.get(event.index);
      if (!block) return;
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta') this.append(block, 'thinking', event.delta.thinking);
        if (event.delta?.type === 'signature_delta') this.append(block, 'signature', event.delta.signature);
      } else if (event.type === 'content_block_stop') {
        // Keep the public block open until its snapshot, next thought or terminal
        // boundary can supply any missing suffix/signature before SSE stop.
        this.current.byIndex.delete(event.index);
      }
    }
  }

  newBlock(generation) {
    const block = { thinking: '', signature: '', closed: false, snapshot: false };
    generation.slots.push(block);
    return block;
  }

  snapshot(value) {
    const blocks = value.message.content.filter(block => block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking);
    if (!blocks.length) return;
    const id = value.message.id;
    let generation = this.generations.get(id);
    // Older CLI streams omit IDs. Associate the next snapshot with unmatched
    // partial blocks, never with all thinking from the entire invocation.
    if (!generation && this.current && !this.current.id && this.current.partial &&
        this.current.slots.some(block => !block.snapshot && block.thinking)) {
      generation = this.current;
      if (id) { generation.id = id; this.generations.set(id, generation); }
    }
    generation ??= this.generation(id);
    if (!this.current) this.current = generation;
    const remembered = generation.snapshots.get(value.uuid);
    const visible = generation.slots.filter(block => block.thinking);
    const pending = visible.filter(block => !block.snapshot);
    // Official CLI snapshots can represent a single reasoning item (uuid), or
    // the whole message. Match the former in stream order and the latter by
    // thinking position, ignoring empty partials and non-thinking content.
    const matches = remembered ?? (blocks.length > 1 ? visible : pending.length ? pending : value.uuid ? [] : visible);
    const mapped = blocks.map((source, index) => {
      const block = matches[index] ?? this.newBlock(generation);
      this.merge(block, 'thinking', source.thinking);
      this.merge(block, 'signature', source.signature);
      block.snapshot = true;
      return block;
    });
    if (value.uuid) generation.snapshots.set(value.uuid, mapped);
  }

  merge(block, field, value) {
    if (typeof value !== 'string' || !value || block[field].startsWith(value)) return;
    if (!value.startsWith(block[field])) this.invalid();
    this.append(block, field, value.slice(block[field].length));
  }

  invalid() {
    throw new BridgeError(502, 'upstream_invalid_thinking', 'CLI public thinking snapshots conflict with the streamed content. No completion was accepted.');
  }

  append(block, field, value) {
    if (typeof value !== 'string' || !value) return;
    if (block.closed) this.invalid();
    block[field] += value;
    if (block.index === undefined && block.thinking) {
      this.finish();
      block.index = this.public.length;
      this.public.push(block);
      this.active = block;
      this.onThinking?.({ type: 'start', index: block.index, thinking: block.thinking, signature: block.signature });
    } else if (block.index !== undefined) {
      this.onThinking?.({ type: field === 'thinking' ? 'delta' : 'signature', index: block.index, [field]: value });
    }
  }

  finish() {
    if (this.active && !this.active.closed) {
      this.active.closed = true;
      this.onThinking?.({ type: 'stop', index: this.active.index });
    }
    this.active = undefined;
  }

  blocks() {
    return this.public.map(({ thinking, signature }) => ({ type: 'thinking', thinking, signature }));
  }
}
