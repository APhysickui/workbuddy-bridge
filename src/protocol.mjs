import { invalid } from './errors.mjs';

function keys(body, allowed) {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid(`Unsupported fields for this text-only bridge: ${unknown.join(', ')}`);
}

function content(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')) {
    return value.map(part => part.text).join('\n');
  }
  throw invalid('Only text content is supported; images, audio and tool results are unavailable.');
}

function messages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw invalid('Provide 1–200 text messages.');
  return value.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalid('Invalid message.');
    keys(message, ['role', 'content', 'type']);
    if (message.type !== undefined && message.type !== 'message') throw invalid('Only message input items are supported.');
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) throw invalid('Unsupported role. Tool messages are unavailable.');
    return { role: message.role, content: content(message.content) };
  });
}

export function normalize(body, kind, models) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object.');
  if (typeof body.model !== 'string' || !models.has(body.model)) throw invalid('Unknown model. See GET /v1/models.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be boolean.');
  let history;
  if (kind === 'chat') {
    keys(body, ['model', 'messages', 'stream', 'stream_options', 'n']);
    if (body.n !== undefined && body.n !== 1) throw invalid('Only n=1 is supported.');
    if (body.stream_options !== undefined) {
      if (!body.stream || !body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options)) throw invalid('stream_options requires stream=true.');
      keys(body.stream_options, ['include_usage']);
      if (typeof body.stream_options.include_usage !== 'boolean') throw invalid('include_usage must be boolean.');
    }
    history = messages(body.messages);
  } else {
    keys(body, ['model', 'input', 'instructions', 'stream', 'store']);
    if (body.store !== undefined && body.store !== false) throw invalid('Only store=false is supported. Resend conversation history for each request.');
    if (body.instructions !== undefined && typeof body.instructions !== 'string') throw invalid('instructions must be a string.');
    history = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : messages(body.input);
    if (body.instructions) history.unshift({ role: 'system', content: body.instructions });
  }
  if (!history.some(message => message.role === 'user')) throw invalid('At least one user message is required.');
  return { model: models.get(body.model), publicModel: body.model, messages: history, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

export function chatCompletion(id, model, result, created) {
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
    ...(result.usage ? { usage: result.usage } : {})
  };
}

export function responseObject(id, model, result, created) {
  return {
    id, object: 'response', created_at: created, status: 'completed', error: null, incomplete_details: null,
    model, store: false, previous_response_id: null,
    output: [{ id: `msg_${id.slice(5)}`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: [] }] }],
    usage: result.usage ? { input_tokens: result.usage.prompt_tokens, output_tokens: result.usage.completion_tokens, total_tokens: result.usage.total_tokens } : null
  };
}

function* pieces(text) {
  const chars = Array.from(text);
  for (let offset = 0; offset < chars.length; offset += 160) yield chars.slice(offset, offset + 160).join('');
}

export function* chatEvents(id, model, result, created, includeUsage) {
  const chunk = (delta, finish = null, choices = true) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: choices ? [{ index: 0, delta, finish_reason: finish }] : [], ...(includeUsage ? { usage: null } : {}) });
  yield { data: chunk({ role: 'assistant', content: '' }) };
  for (const text of pieces(result.text)) yield { data: chunk({ content: text }) };
  yield { data: chunk({}, 'stop') };
  if (includeUsage) yield { data: { ...chunk({}, null, false), usage: result.usage } };
  yield { data: '[DONE]' };
}

export function* responseEvents(id, model, result, created) {
  const full = responseObject(id, model, result, created);
  const message = full.output[0];
  let sequence = 0;
  const event = (type, fields) => ({ event: type, data: { type, sequence_number: sequence++, ...fields } });
  yield event('response.created', { response: { ...full, status: 'in_progress', output: [], usage: null } });
  yield event('response.in_progress', { response: { ...full, status: 'in_progress', output: [], usage: null } });
  yield event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  const position = { item_id: message.id, output_index: 0, content_index: 0 };
  yield event('response.content_part.added', { ...position, part: { type: 'output_text', text: '', annotations: [] } });
  for (const delta of pieces(result.text)) yield event('response.output_text.delta', { ...position, delta });
  yield event('response.output_text.done', { ...position, text: result.text });
  yield event('response.content_part.done', { ...position, part: message.content[0] });
  yield event('response.output_item.done', { output_index: 0, item: message });
  yield event('response.completed', { response: full });
}
