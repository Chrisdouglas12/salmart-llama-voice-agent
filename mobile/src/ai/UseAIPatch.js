/**
 * Form-fill patch hook.
 *
 * Each form screen calls useAIPatch(target) and receives a one-shot
 * { fields, say } patch to apply. Patches come from two sources:
 *
 * 1. A fresh turn. While the user is in AI Mode, prepareAdForm,
 *    fillRequestForm and fillProfileForm emit a fill_* block in the assistant
 *    message. The hook reads it from useAI().messages, so the patch is ready
 *    when the user returns to the form.
 * 2. A queued patch. If a turn ran while the form was unmounted, the backend
 *    stored the patch and the hook drains it on mount or focus through
 *    POST /api/ai/forms/drain.
 *
 * Usage:
 *   const { patch, ack } = useAIPatch('createAd');
 *   useEffect(() => {
 *     if (!patch) return;
 *     applyPatch(patch.fields);
 *     if (patch.say) toast(patch.say);
 *     ack();
 *   }, [patch]);
 *
 * ack() is separate from applying the patch so the screen can wait until it
 * has finished loading an existing draft.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAI } from './AIContext';
import { useAuth } from '../state/AuthContext';
import { drainFormPatch } from './api';

const VALID_TARGETS = new Set(['createAd', 'createRequest', 'editProfile', 'register']);

// fill_ad maps to createAd, and so on. open_picker also goes to the create-ad
// screen; it carries no fields, only a kind ('photo', 'camera' or
// 'digitalFile').
const BLOCK_TO_TARGET = {
  fill_ad: 'createAd',
  fill_request: 'createRequest',
  fill_profile: 'editProfile',
  fill_register: 'register',
  register_focus: 'register',
  open_picker: 'createAd',
};

// Steps the register screen is allowed to open by itself.
const REGISTER_FOCUS = new Set(['fullName', 'firstName', 'lastName', 'email', 'phoneNumber', 'phone', 'password', 'agreement']);

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
  // target. `lastSeenMsgKeyRef` prevents the same message from being applied
  // twice on a re-render.
  useEffect(() => {
    if (!messages.length) return;
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'assistant') return;
    if (latest.key === lastSeenMsgKeyRef.current) return;

    const blocks = Array.isArray(latest.structured) ? latest.structured : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (BLOCK_TO_TARGET[b.type] !== target) continue;
      // The server-owned plan names the next step. No field values travel.
      if (b.type === 'register_focus') {
        const field = String(b.field || '');
        if (!REGISTER_FOCUS.has(field)) continue;
        lastSeenMsgKeyRef.current = latest.key;
        setPatch({ fields: {}, focus: field, say: null, source: 'turn' });
        return;
      }
      // Picker requests carry a kind, not fields.
      if (b.type === 'open_picker') {
        if (b.kind !== 'photo' && b.kind !== 'camera' && b.kind !== 'digitalFile') continue;
        lastSeenMsgKeyRef.current = latest.key;
        setPatch({ fields: {}, request: { kind: b.kind, auto: b.auto === true }, say: b.say || null, source: 'turn' });
        return;
      }
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
  // Runs once per mount when the user is signed in. A queued patch belongs to
  // a turn that ran while this form was unmounted. A null response means
  // nothing is waiting, so state stays unchanged.
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
      // Keep `drainedRef` false on a network failure so the app-foreground
      // listener can retry. Errors never reach the screen.
      drainedRef.current = false;
    }
  }, [isAuthenticated, target, patch]);

  useEffect(() => {
    tryDrain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, target]);

  // Retry when the app returns to the foreground after a failed cold start.
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