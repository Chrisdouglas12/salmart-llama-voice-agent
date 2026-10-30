/**
 * Salmart AI Mode — form-fill consumer hook
 *
 * Cycle 1 replacement for `useAssistant().adPatch` / `.requestPatch` /
 * `.profilePatch`. The 4 form screens each own their own copy of this hook's
 * state — they call `useAIPatch('createAd')` (or 'createRequest' /
 * 'editProfile') and receive a one-shot { fields, say } patch they can apply.
 *
 * Two sources feed a patch:
 *
 *  1. Fresh turn responses. While the user is inside AI Mode, every turn that
 *     runs prepareAdForm / fillRequestForm / fillProfileForm emits a
 *     `fill_ad` / `fill_request` / `fill_profile` block. We read those out of
 *     `useAI().messages` synchronously, so the moment the user pops back to the
 *     form the patch is available.
 *
 *  2. Backend drain. If a turn ran while the form was unmounted (user was
 *     inside AI Mode, form lives on a lower screen), we cannot see the message
 *     from here. The backend persisted the patch to AIPendingFormPatch; this
 *     hook drains it on mount / focus via POST /api/ai/forms/drain.
 *
 * Contract with the form screen:
 *   const { patch, ack } = useAIPatch('createAd');
 *   useEffect(() => {
 *     if (!patch) return;
 *     applyPatch(patch.fields);  // your existing apply logic
 *     if (patch.say) toast(patch.say);
 *     ack();                     // clears the hook state so it fires once
 *   }, [patch]);
 *
 * `ack()` is deliberately separate from `applyPatch` — the screen must be able
 * to decide when it is safe to consume (e.g. after it finishes loading an
 * existing draft).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAI } from './AIContext';
import { useAuth } from '../state/AuthContext';
import { drainFormPatch } from './api';

const VALID_TARGETS = new Set(['createAd', 'createRequest', 'editProfile', 'register']);

// 'fill_ad' → 'createAd', etc.
const BLOCK_TO_TARGET = {
  fill_ad: 'createAd',
  fill_request: 'createRequest',
  fill_profile: 'editProfile',
  fill_register: 'register',
};

export function useAIPatch(target) {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`useAIPatch: unknown target "${target}"`);
  }

  const { isAuthenticated } = useAuth();
  const { messages } = useAI();
  const [patch, setPatch] = useState(null);
  const drainedRef = useRef(false);
  const mountedRef = useRef(true);
  const lastSeenMsgKeyRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Source 1: fresh turn results ──────────────────────────────────────────
  // Scan the newest assistant message once for a fill_* block matching this
  // target. `lastSeenMsgKeyRef` prevents re-emitting the same message twice
  // (a re-render would otherwise re-apply the patch).
  useEffect(() => {
    if (!messages.length) return;
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'assistant') return;
    if (latest.key === lastSeenMsgKeyRef.current) return;

    const blocks = Array.isArray(latest.structured) ? latest.structured : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (BLOCK_TO_TARGET[b.type] !== target) continue;
      if (!b.fields || typeof b.fields !== 'object') continue;

      lastSeenMsgKeyRef.current = latest.key;
      setPatch({ fields: b.fields, say: b.say || null, source: 'turn' });
      return;
    }
    // Still mark the message as seen even if it didn't carry our target — the
    // next message is the one we care about.
    lastSeenMsgKeyRef.current = latest.key;
  }, [messages, target]);

  // ── Source 2: backend drain ───────────────────────────────────────────────
  // Fires once per mount when authenticated. If a patch was queued by a turn
  // that ran while this form was unmounted, this call picks it up. A null
  // response means nothing is waiting — no state change.
  const tryDrain = useCallback(async () => {
    if (!isAuthenticated) return;
    if (drainedRef.current) return;
    drainedRef.current = true;
    try {
      const res = await drainFormPatch(target);
      if (!mountedRef.current) return;
      if (res?.success && res.patch?.fields && !patch) {
        setPatch({ fields: res.patch.fields, say: res.patch.say || null, source: 'drain' });
      }
    } catch (_e) {
      // Network failure: keep `drainedRef` false so the app-foreground listener
      // can retry on the next resume. Never let this throw into the screen.
      drainedRef.current = false;
    }
  }, [isAuthenticated, target, patch]);

  useEffect(() => {
    tryDrain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, target]);

  // Retry on app foreground if the first drain failed on a cold start.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      if (!drainedRef.current) tryDrain();
    });
    return () => sub.remove();
  }, [tryDrain]);

  const ack = useCallback(() => setPatch(null), []);

  return { patch, ack };
}