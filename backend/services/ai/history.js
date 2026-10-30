'use strict';

/**
 * services/ai/history.js
 *
 * History hygiene for the model replay window.
 *
 * OpenAI-compatible chat APIs reject an assistant message whose `tool_calls`
 * have no matching `tool` responses. A timed-out or failed turn can store
 * exactly that: agentRunner appends the assistant tool_calls message, then
 * dies (timeout / provider error) before all tool responses are recorded.
 * Without repair, EVERY later turn replays the poisoned pair and fails with
 * `400 Missing tool response for tool_call_id(s)` — one bad turn bricks the
 * whole conversation.
 *
 * sanitizeHistory() drops orphaned tool_calls groups (and stray tool
 * messages left by window truncation) so the replay always consists of
 * complete pairs. Filtering at replay time also self-heals conversations
 * poisoned before this fix shipped — no DB migration needed.
 *
 * Stored shapes in:  assistant { role, content, toolCalls? },
 *                    tool { role:'tool', content, toolCallId, name }.
 * Model shapes out:  assistant { role, content, tool_calls? },
 *                    tool { role:'tool', content, tool_call_id, name }.
 */

/**
 * @param {Array} messages stored messages (oldest first)
 * @returns {{ messages: Array, dropped: number }} sanitized stored messages
 */
function sanitizeHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let dropped = 0;

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') { dropped++; continue; }

    const calls = m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
      ? m.toolCalls
      : null;

    if (!calls) {
      // A tool message with no preceding assistant tool_calls in this window
      // (truncation cut its pair) can never validate — drop it.
      if (m.role === 'tool') { dropped++; continue; }
      out.push(m);
      continue;
    }

    const pending = new Set();
    for (const c of calls) {
      if (c && c.id) pending.add(c.id);
    }
    const responses = [];
    let j = i + 1;
    while (j < list.length && list[j] && list[j].role === 'tool' && pending.has(list[j].toolCallId)) {
      responses.push(list[j]);
      pending.delete(list[j].toolCallId);
      j++;
    }
    if (pending.size === 0) {
      out.push(m, ...responses);
    } else {
      dropped++;
    }
    i = j - 1;
  }

  return { messages: out, dropped };
}

/**
 * Map stored messages to the model wire shape. Assumes sanitized input.
 */
function toModelMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content || '' };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      return { role: 'assistant', content: m.content || '', tool_calls: m.toolCalls };
    }
    return { role: m.role, content: m.content || '' };
  });
}

module.exports = { sanitizeHistory, toModelMessages };
