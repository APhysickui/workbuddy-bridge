// Public thinking may accompany a sentinel reply. Tools, opaque blocks and
// malformed content never count as proof that the requested text was returned.
export function hasExactTextReply(content, expected) {
  return Array.isArray(content) && content.every(block =>
    block?.type === 'text' && typeof block.text === 'string' ||
    block?.type === 'thinking' && typeof block.thinking === 'string' &&
      (block.signature === undefined || typeof block.signature === 'string')) &&
    content.filter(block => block.type === 'text').map(block => block.text).join('').trim() === expected;
}
