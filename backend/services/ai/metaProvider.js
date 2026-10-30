'use strict';

/**
 * services/ai/metaProvider.js
 *
 * Thin adapter over the existing `lib/assistant/llama.js#chatCompletion`,
 * which already speaks Meta's OpenAI-compatible wire format correctly
 * (see runMetaAgent in routes/assistantRoutes.js).
 *
 * We do NOT duplicate the Meta HTTP client. This file only:
 *   1. normalizes tool defs into OpenAI `tools` shape
 *   2. converts our model message history into the shape llama.js expects
 *   3. surfaces a clean discriminated result to agentRunner
 */

const { chatCompletion } = require('../../lib/assistant/llama');

/**
 * @param {object} opts
 * @param {Array} opts.messages       OpenAI-style
 * @param {Array} opts.tools          [{ name, description, inputSchema }]
 * @param {string} opts.requestId
 * @returns {{kind:'final'|'tool_calls', text:string|null, toolCalls:Array, raw:any}}
 */
async function chat({ messages, tools = [], requestId }) {
  const started = Date.now();
  const openaiTools = tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  let raw;
  let model;
  try {
    ({ raw, model } = await chatCompletion({
      messages,
      tools: openaiTools.length ? openaiTools : undefined,
      toolChoice: openaiTools.length ? 'auto' : undefined,
      temperature: 0.2,
      maxTokens: 2000,
    }));
  } catch (err) {
    // One trace line per failed model call: requestId ties it to the
    // agentRunner turn lines, the model id names the dead id.
    console.warn(`[metaProvider] chat FAILED: requestId=${requestId} model=${err?.model || '?'} status=${err?.status || ''} ms=${Date.now() - started} ${err?.message || err}`);
    throw err;
  }

  const msg = raw?.choices?.[0]?.message || {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  console.log(`[metaProvider] chat ok: requestId=${requestId} model=${model || '?'} ms=${Date.now() - started} kind=${rawCalls.length ? 'tool_calls' : 'final'} toolCalls=${rawCalls.length}`);

  if (rawCalls.length === 0) {
    return { kind: 'final', text: (msg.content || '').trim(), toolCalls: [], raw };
  }

  return {
    kind: 'tool_calls',
    text: msg.content || null,
    toolCalls: rawCalls.map(tc => {
      let args = {};
      if (typeof tc.function?.arguments === 'string') {
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      } else if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments;
      }
      return { id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, arguments: args };
    }),
    raw,
  };
}

module.exports = { chat };