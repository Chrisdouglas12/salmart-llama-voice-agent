'use strict';

/**
 * services/ai/agentRunner.js
 *
 * Runs one turn of the agent. The returned `toolResults` array is what lets
 * aiRoutes.js surface authoritative product/order data to the frontend —
 * without it, the only truth the frontend gets is the model's prose.
 *
 * `toolResults` entries: { name, ok, code?, data? }
 *   - data is the raw handler return value on success.
 *   - data is null when ok is false.
 */

const metaProvider = require('./metaProvider');
const toolExecutor = require('./toolExecutor');
const { toolsForContext, toModelDefs } = require('./toolRegistry');

// A spoken turn should finish in seconds, so the loop is deliberately short.
// Two tool rounds plus the final answer fit; a third round would mean the model
// is looping, and the user is better served by the next question.
const MAX_ITERATIONS = 3;
const MAX_TOOL_CALLS = 6;
const WALL_CLOCK_MS  = 25_000;

async function runTurn({ ctx, messages, signal }) {
  const started = Date.now();
  const newMessages = [];
  const toolLog = [];
  const toolResults = [];
  let pendingConfirmation = null;
  let toolCallCount = 0;
  let llmMs = 0;
  let toolMs = 0;
  let llmCalls = 0;
  const seenCalls = new Set();

  const contextTools = toolsForContext({
    isAuthenticated: ctx.isAuthenticated,
    allowedPermissions: ['product:read', 'seller:own', 'message:own', 'order:own'],
  });
  const toolDefs = toModelDefs(contextTools);
  const promptChars = (messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  ctx.logger?.info?.(`[agentRunner] turn start: requestId=${ctx.requestId} msgs=${(messages || []).length} chars=${promptChars} tools=${toolDefs.length} auth=${!!ctx.isAuthenticated}`);

  const modelMessages = [...messages];
  let finalText = '';
  let stopReason = 'final';
  // The exact chat model id that answered, so the app can show it honestly
  // ("response by …") instead of a hardcoded label.
  let usedModel = null;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (Date.now() - started > WALL_CLOCK_MS) { stopReason = 'timeout'; break; }

    let resp;
    const llmStarted = Date.now();
    llmCalls++;
    // Hand the remaining wall-clock budget to the provider call, so a stuck
    // request cannot outlive the turn.
    const remainingMs = WALL_CLOCK_MS - (Date.now() - started);
    if (remainingMs < 1500) { stopReason = 'timeout'; break; }
    try {
      resp = await metaProvider.chat({
        messages: modelMessages,
        tools: toolDefs,
        requestId: ctx.requestId,
        timeoutMs: remainingMs,
      });
      if (resp?.model) usedModel = resp.model;
    } catch (err) {
      stopReason = 'error';
      finalText = 'The assistant is temporarily unavailable. Please try again.';
      ctx.logger?.warn?.(`[agentRunner] turn FAILED: requestId=${ctx.requestId} iter=${iter + 1} llmMs=${Date.now() - llmStarted} error=${err.message}`);
      break;
    } finally {
      llmMs += Date.now() - llmStarted;
    }

    if (resp.kind === 'final') {
      finalText = resp.text || '';
      newMessages.push({ role: 'assistant', content: finalText });
      break;
    }

    if (toolCallCount + resp.toolCalls.length > MAX_TOOL_CALLS) {
      stopReason = 'tool_call_limit';
      finalText = 'That task needs more steps than I can take in one turn. Please answer the last question and I will continue.';
      break;
    }

    newMessages.push({
      role: 'assistant',
      content: resp.text || '',
      tool_calls: resp.toolCalls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });
    modelMessages.push(newMessages[newMessages.length - 1]);

    for (const tc of resp.toolCalls) {
      if (Date.now() - started > WALL_CLOCK_MS) { stopReason = 'timeout'; break; }

      const key = `${tc.name}:${canonicalJson(tc.arguments)}`;
      if (seenCalls.has(key)) {
        toolLog.push({ name: tc.name, ok: false, code: 'DUPLICATE_TOOL_CALL' });
        toolResults.push({ name: tc.name, ok: false, code: 'DUPLICATE_TOOL_CALL', data: null });
        modelMessages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.name,
          content: JSON.stringify({ ok: false, code: 'DUPLICATE_TOOL_CALL', error: 'Already attempted this turn.' }),
        });
        continue;
      }
      seenCalls.add(key);
      toolCallCount++;

      const toolStarted = Date.now();
      const result = await toolExecutor.execute(ctx, tc.name, tc.arguments);
      const elapsed = Date.now() - toolStarted;
      toolMs += elapsed;
      toolLog.push({
        name: tc.name,
        ok: result.ok,
        code: result.code,
        ms: elapsed,
        ...(result.actionId && { actionId: result.actionId }),
        ...(result.summary && { summary: result.summary }),
        ...(result.preview && { preview: result.preview }),
      });
      toolResults.push({
        name: tc.name,
        ok: result.ok,
        code: result.code,
        data: result.ok ? result.data : null,
      });

      if (result.code === 'CONFIRMATION_REQUIRED' && !pendingConfirmation) {
        pendingConfirmation = {
          actionId: result.actionId,
          toolName: result.toolName,
          summary: result.summary,
          preview: result.preview,
        };
      }

      modelMessages.push({
        role: 'tool', tool_call_id: tc.id, name: tc.name,
        content: JSON.stringify(result),
      });
    }

    if (stopReason === 'timeout') break;
  }

  if (stopReason === 'final' && !finalText) {
    finalText = 'I was not able to complete that. Could you rephrase or add a bit more detail?';
  }

  ctx.logger?.info?.(`[agentRunner] turn end: requestId=${ctx.requestId} stop=${stopReason} llmMs=${llmMs} toolMs=${toolMs} llmCalls=${llmCalls} toolCalls=${toolCallCount} totalMs=${Date.now() - started}`);

  return {
    finalText, turns: newMessages, toolLog, toolResults, stopReason, pendingConfirmation,
    model: usedModel,
    timings: { llmMs, toolMs, llmCalls, totalMs: Date.now() - started },
  };
}

function canonicalJson(o) {
  try { return JSON.stringify(o, Object.keys(o || {}).sort()); }
  catch { return String(o); }
}

module.exports = { runTurn, MAX_ITERATIONS, MAX_TOOL_CALLS, WALL_CLOCK_MS };