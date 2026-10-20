import { createHash } from 'node:crypto';
import { invalid, BridgeError } from './errors.mjs';
import { normalizeAnthropic } from './anthropic.mjs';
import { startSse, writeSse } from './anthropic-stream.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const toolKey = (name, namespace) => JSON.stringify([namespace ?? null, name]);
const alias = (name, namespace) => 'rsp_' + createHash('sha256').update(toolKey(name, namespace)).digest('hex').slice(0, 24);
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(part => !object(part) ||
      !['text', 'input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string')) {
    throw invalid('Responses supports text content only; images, audio and opaque tool results are unavailable.');
  }
  return content.map(part => part.text).join('\n');
}
function parseArguments(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch {}
  if (!object(parsed)) throw invalid('function_call.arguments must contain a JSON object.');
  return parsed;
}

export function normalizeResponses(body, models) {
  if (!object(body)) throw invalid('Request body must be an object.');
  const allowed = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'store',
    'max_output_tokens', 'reasoning', 'text', 'temperature', 'top_p', 'include', 'metadata', 'prompt_cache_key',
    'prompt_cache_retention', 'previous_response_id', 'truncation', 'service_tier', 'background', 'safety_identifier',
    'stream_options', 'client_metadata', 'access_programs'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid('Unsupported Responses request fields.');
  if (body.store !== undefined && body.store !== false || body.previous_response_id != null || body.background === true) {
    throw invalid('Use store=false and resend the full conversation; stored/background responses are unavailable.');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw invalid('parallel_tool_calls must be boolean.');
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw invalid('instructions must be a string.');
  if (body.text !== undefined && (!object(body.text) || body.text.format && body.text.format.type !== 'text')) {
    throw invalid('Only text output format is supported; structured response formats are unavailable.');
  }
  if (body.reasoning !== undefined && !object(body.reasoning)) throw invalid('reasoning must be an object.');
  if (body.stream_options != null && (!object(body.stream_options) || Object.keys(body.stream_options).some(key => key !== 'include_obfuscation') ||
      body.stream_options.include_obfuscation !== undefined && typeof body.stream_options.include_obfuscation !== 'boolean')) {
    throw invalid('Only boolean stream_options.include_obfuscation is accepted as advisory metadata.');
  }
  if (body.client_metadata != null && !object(body.client_metadata)) throw invalid('client_metadata must be an object.');
  if (body.access_programs != null && (!Array.isArray(body.access_programs) || body.access_programs.length)) {
    throw invalid('OpenAI access programs are unavailable through this provider.');
  }
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.some(value => !['reasoning.encrypted_content', 'output.encrypted_content'].includes(value)))) {
    throw invalid('Only reasoning/output encrypted_content include fields are accepted as advisory requests; opaque content is not generated.');
  }
  const responseTools = new Map();
  const tools = [];
  function addTools(definitions, namespace) {
    if (!Array.isArray(definitions)) throw invalid('tools must be an array.');
    for (const tool of definitions) {
      if (!object(tool)) throw invalid('Invalid Responses tool definition.');
      if (tool.type === 'namespace' && !namespace) {
        if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) throw invalid('Invalid tool namespace.');
        addTools(tool.tools, tool.name); continue;
      }
      if (!['function', 'custom'].includes(tool.type) || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) {
        throw invalid('Only function, custom and single-level namespace tools are supported; server-side tools are unavailable.');
      }
      const name = alias(tool.name, namespace);
      if (responseTools.has(name)) throw invalid('Duplicate Responses tool definition.');
      let description = `${namespace ? namespace + '.' : ''}${tool.name}. ${tool.description ?? ''}`;
      if (tool.type === 'custom') {
        if (tool.format && (!object(tool.format) || !['text', 'grammar'].includes(tool.format.type))) throw invalid('Invalid custom tool format.');
        if (tool.format?.type === 'grammar') {
          if (!['lark', 'regex'].includes(tool.format.syntax) || typeof tool.format.definition !== 'string') throw invalid('Invalid custom tool grammar.');
          description += `\nReturn the raw client tool input in the input string, following this ${tool.format.syntax} grammar:\n${tool.format.definition}`;
        }
        description += '\nThis is a client custom tool. Supply its raw input as {"input":"..."}; do not wrap that string in another JSON envelope.';
      } else if (!object(tool.parameters)) throw invalid('Function tools require an object parameters schema.');
      responseTools.set(name, { type: tool.type, name: tool.name, ...(namespace ? { namespace } : {}) });
      tools.push({ name, description, input_schema: tool.type === 'custom'
        ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
        : tool.parameters });
    }
  }
  addTools(body.tools ?? []);
  const choice = body.tool_choice ?? 'auto';
  let toolChoice;
  if (['auto', 'none', 'required'].includes(choice)) toolChoice = { type: choice === 'required' ? 'any' : choice };
  else if (object(choice) && ['function', 'custom'].includes(choice.type) && typeof choice.name === 'string') {
    const name = alias(choice.name, choice.namespace);
    if (responseTools.get(name)?.type !== choice.type) throw invalid('tool_choice references an unknown tool.');
    toolChoice = { type: 'tool', name };
  } else throw invalid('Unsupported Responses tool_choice.');
  if (body.parallel_tool_calls === false) toolChoice.disable_parallel_tool_use = true;

  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(items) || !items.length || items.length > 1500) throw invalid('Provide 1–1500 Responses input items.');
  const messages = [];
  const calls = new Map();
  function append(role, blocks) {
    if (!blocks.length) return;
    if (messages.at(-1)?.role === role && ['user', 'assistant'].includes(role)) messages.at(-1).content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  for (const item of items) {
    if (!object(item)) throw invalid('Invalid Responses input item.');
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) throw invalid('Unsupported Responses message role.');
      append(item.role, [{ type: 'text', text: textContent(item.content) }]);
    } else if (type === 'reasoning') {
      if (!Array.isArray(item.summary)) throw invalid('Reasoning history must provide a summary array.');
      if (item.content != null && !Array.isArray(item.content)) throw invalid('Invalid public reasoning content.');
      const publicParts = [...item.summary, ...(item.content ?? [])];
      if (publicParts.some(part => !object(part) || !['summary_text', 'reasoning_text', 'text'].includes(part.type) || typeof part.text !== 'string')) {
        throw invalid('Invalid public reasoning history.');
      }
      const thinking = publicParts.map(part => part.text).join('\n');
      if (thinking) append('assistant', [{ type: 'thinking', thinking, signature: '' }]);
      // encrypted_content is opaque and never interpreted or invented.
    } else if (['function_call', 'custom_tool_call'].includes(type)) {
      if (typeof item.call_id !== 'string' || !item.call_id || calls.has(item.call_id) || typeof item.name !== 'string') throw invalid('Invalid or duplicate Responses call_id.');
      const kind = type === 'custom_tool_call' ? 'custom' : 'function';
      if (kind === 'custom' && typeof item.input !== 'string') throw invalid('Custom tool input must be a string.');
      calls.set(item.call_id, kind);
      append('assistant', [{ type: 'tool_use', id: item.call_id, name: alias(item.name, item.namespace),
        input: kind === 'custom' ? { input: item.input } : parseArguments(item.arguments) }]);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(type)) {
      const expected = type === 'custom_tool_call_output' ? 'custom' : 'function';
      if (calls.get(item.call_id) !== expected) throw invalid('Tool output must match a preceding call and its type exactly once.');
      calls.set(item.call_id, 'completed');
      append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: textContent(item.output) }]);
    } else throw invalid(`Unsupported Responses input type: ${typeof type === 'string' ? type : 'unknown'}. Resend full text/tool history.`);
  }
  const effort = body.reasoning?.effort;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw invalid('Unsupported reasoning effort.');
  const normalized = normalizeAnthropic({ model: body.model, messages, system: body.instructions ?? '', tools,
    tool_choice: toolChoice, max_tokens: body.max_output_tokens ?? 4096, stream: body.stream,
    ...(effort && effort !== 'none' ? { output_config: { effort } } : {}) }, models);
  return { ...normalized, responseTools,
    advisoryFields: ['max_output_tokens', 'temperature', 'top_p', 'reasoning', 'text', 'include', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier', 'stream_options', 'client_metadata'].filter(key => key in body)
      .concat([...responseTools.values()].some(tool => tool.type === 'custom') ? ['custom_tool_grammar'] : []) };
}

export function responseObject(id, model, result, created, input = {}) {
  const content = result.content ?? [{ type: 'text', text: result.text }];
  const hasTools = content.some(block => block.type === 'tool_use');
  const output = content.map((block, index) => {
    const itemId = `${block.type === 'thinking' ? 'rs' : block.type === 'tool_use' ? 'fc' : 'msg'}_${id.slice(5)}_${index}`;
    if (block.type === 'thinking') return { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: block.thinking }] };
    if (block.type === 'text') return { id: itemId, type: 'message', role: 'assistant', status: 'completed',
      phase: hasTools ? 'commentary' : 'final_answer', content: [{ type: 'output_text', text: block.text, annotations: [] }] };
    const tool = input.responseTools?.get(block.name);
    if (!tool) throw new BridgeError(502, 'upstream_invalid_tool_protocol', 'The model returned an unknown Responses client tool.');
    return { id: itemId, type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call', status: 'completed',
      call_id: block.id, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}),
      ...(tool.type === 'custom' ? { input: block.input.input } : { arguments: JSON.stringify(block.input) }) };
  });
  const usage = result.usage;
  return { id, object: 'response', created_at: created, status: 'completed', error: null, incomplete_details: null,
    model, store: false, previous_response_id: null, output,
    usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 } } : null };
}

const pieces = function* (text) {
  const chars = Array.from(text);
  for (let offset = 0; offset < chars.length; offset += 160) yield chars.slice(offset, offset + 160).join('');
};
function eventFactory() {
  let sequence = 0;
  return (type, fields = {}) => ({ event: type, data: { type, sequence_number: sequence++, ...fields } });
}
export function* responseEvents(id, model, result, created, input = {}, options = {}) {
  const full = responseObject(id, model, result, created, input);
  const event = options.event ?? eventFactory();
  if (options.start !== false) {
    yield event('response.created', { response: { ...full, status: 'in_progress', output: [], usage: null } });
    yield event('response.in_progress', { response: { ...full, status: 'in_progress', output: [], usage: null } });
  }
  for (const [index, item] of full.output.entries()) {
    if (index < (options.skipItems ?? 0)) continue;
    const position = { item_id: item.id, output_index: index };
    yield event('response.output_item.added', { output_index: index, item: { ...item,
      ...(item.type === 'message' ? { content: [], status: 'in_progress' }
        : item.type === 'reasoning' ? { summary: [] }
          : item.type === 'function_call' ? { arguments: '', status: 'in_progress' } : { input: '', status: 'in_progress' }) } });
    if (item.type === 'message') {
      const part = item.content[0]; const fields = { ...position, content_index: 0 };
      yield event('response.content_part.added', { ...fields, part: { ...part, text: '' } });
      for (const delta of pieces(part.text)) yield event('response.output_text.delta', { ...fields, delta });
      yield event('response.output_text.done', { ...fields, text: part.text });
      yield event('response.content_part.done', { ...fields, part });
    } else if (item.type === 'reasoning') {
      const part = item.summary[0], fields = { ...position, summary_index: 0 };
      yield event('response.reasoning_summary_part.added', { ...fields, part: { ...part, text: '' } });
      for (const delta of pieces(part.text)) yield event('response.reasoning_summary_text.delta', { ...fields, delta });
      yield event('response.reasoning_summary_text.done', { ...fields, text: part.text });
      yield event('response.reasoning_summary_part.done', { ...fields, part });
    } else {
      const custom = item.type === 'custom_tool_call', field = custom ? 'input' : 'arguments';
      for (const delta of pieces(item[field])) yield event(`response.${custom ? 'custom_tool_call_input' : 'function_call_arguments'}.delta`, { ...position, delta });
      yield event(`response.${custom ? 'custom_tool_call_input' : 'function_call_arguments'}.done`, { ...position, [field]: item[field] });
    }
    yield event('response.output_item.done', { output_index: index, item });
  }
  yield event('response.completed', { response: full });
}

export class ResponsesThinkingStream {
  constructor(response, id, model, created, input, signal) {
    Object.assign(this, { response, id, model, created, input, signal });
    this.event = eventFactory(); this.blocks = []; this.started = false;
  }
  write(type, fields) { writeSse(this.response, this.event(type, fields)); }
  accept(value) {
    if (this.signal.aborted || this.response.destroyed) return;
    if (value.type === 'start') {
      if (value.index !== this.blocks.length || !value.thinking) this.invalid();
      if (!this.started) {
        startSse(this.response); this.started = true;
        const full = responseObject(this.id, this.model, { content: [], usage: null }, this.created);
        this.write('response.created', { response: { ...full, status: 'in_progress' } });
        this.write('response.in_progress', { response: { ...full, status: 'in_progress' } });
      }
      const item = { id: `rs_${this.id.slice(5)}_${value.index}`, type: 'reasoning', summary: [] };
      this.blocks.push({ item, text: value.thinking, closed: false });
      this.write('response.output_item.added', { output_index: value.index, item });
      const fields = { item_id: item.id, output_index: value.index, summary_index: 0 };
      this.write('response.reasoning_summary_part.added', { ...fields, part: { type: 'summary_text', text: '' } });
      this.write('response.reasoning_summary_text.delta', { ...fields, delta: value.thinking });
      return;
    }
    const block = this.blocks[value.index];
    if (!block || block.closed) return;
    if (value.type === 'delta') {
      block.text += value.thinking;
      this.write('response.reasoning_summary_text.delta', { item_id: block.item.id, output_index: value.index, summary_index: 0, delta: value.thinking });
    }
    if (value.type === 'stop') this.close(value.index);
  }
  close(index) {
    const block = this.blocks[index];
    if (block.closed) return;
    const part = { type: 'summary_text', text: block.text };
    const fields = { item_id: block.item.id, output_index: index, summary_index: 0 };
    this.write('response.reasoning_summary_text.done', { ...fields, text: block.text });
    this.write('response.reasoning_summary_part.done', { ...fields, part });
    this.write('response.output_item.done', { output_index: index, item: { ...block.item, summary: [part] } });
    block.closed = true;
  }
  *finish(result) {
    for (const [index, block] of this.blocks.entries()) {
      const final = result.content[index];
      if (final?.type !== 'thinking' || final.thinking !== block.text) this.invalid();
      this.close(index);
    }
    yield* responseEvents(this.id, this.model, result, this.created, this.input,
      { start: false, skipItems: this.blocks.length, event: this.event });
  }
  invalid() { throw new BridgeError(502, 'upstream_invalid_thinking', 'Responses reasoning stream disagrees with the validated final result.'); }
  failure(error) {
    const response = responseObject(this.id, this.model, { content: [], usage: null }, this.created);
    return this.event('response.failed', { response: { ...response, status: 'failed', error: { code: error.code, message: error.message } } });
  }
}
