/**
 * AI conversation state and voice pipeline.
 *
 * Owns the /api/ai/* conversation lifecycle and the global microphone.
 *
 * Persistence:
 * - `anonymousId` is stored in AsyncStorage under `salmart:ai:anonymousId`.
 *   It is a client-held identity token, not a secret, so AsyncStorage is
 *   consistent with AuthContext.
 * - Conversation history lives on the backend. The local `messages` array is
 *   a render cache; `reset()` clears it and starts a new conversation.
 *
 * Sign-in rebind:
 * - When `isAuthenticated` changes from false to true, the provider calls
 *   POST /conversations/rebind with the stored anonymousId so the same
 *   conversation continues. A 404 (mismatched or lost anonymous id) starts a
 *   fresh conversation silently.
 * - If the rebind follows a real pre-auth conversation, one resume turn runs
 *   and is spoken, so the unfinished request continues. A manual sign-in with
 *   no AI history stays silent.
 * - Signing out clears everything locally, so the next user starts empty.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { apiUpload } from '../api/client';

import { useAuth } from '../state/AuthContext';
import { useNavActions } from '../state/Navigation';
import { TAB_ROOTS } from '../state/routes';
import { runGoogleAuth } from '../utils/oauth';
import {
  createConversation, rebindConversation, sendTurn, sendTurnStream,
  selectProductToCart,
  confirmAction as apiConfirm, cancelAction as apiCancel,
} from './api';
import { speakReply, queueSpeech, stopSpeaking } from './speak';
import { takeAuthOutcome } from './authOutcome';
import { peekFormSnapshot } from './formSnapshot';
import { peekRegistrationSnapshot, takeRegistrationSnapshot } from './registrationSnapshot';

const ANON_KEY = 'salmart:ai:anonymousId';

// Mirrors the server allowlist in services/ai/tools/navigationTools.js. The
// client checks again so a malformed response cannot open an unknown screen.
const NAVIGABLE_SCREENS = new Set([
  'market', 'requests', 'alerts', 'messages', 'deals', 'profile',
  'search', 'cart', 'referral', 'createAd', 'createRequest', 'editProfile',
  'ads', 'promote', 'showrooms', 'vtu',
  'register', 'signin', 'verifyEmail', 'passwordReset',
]);
const PANEL_ROUTES = new Set(TAB_ROOTS);

const AIContext = createContext(null);

let seq = 0;
const newKey = () => `ai-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** Referral code carried inside the server-built Google initiation URL. */
function referralFromUrl(url) {
  const match = /[?&]ref=([^&#]+)/.exec(String(url || ''));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]).slice(0, 64) || undefined;
  } catch (_e) {
    return undefined;
  }
}

export function AIProvider({ children }) {
  const { ready: authReady, isAuthenticated, adoptWebSession } = useAuth();
  const nav = useNavActions();

  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');       // 'idle' | 'sending' | 'error'
  const [error, setError] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Latest content for the global mic card. `confirmation` keeps the turn's
  // Confirm/Cancel actions available inline.
  const [lastVoice, setLastVoice] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  // Attention nudge for the mic button (welcome pulse, "Tap to talk"). It does
  // not record; it only animates the button. Cleared when recording starts.
  const [micNudge, setMicNudge] = useState(null);
  // Silence auto-stop polling interval. A noisy place that never falls quiet
  // still works because the user can stop manually.
  const SILENCE_DB = -35;
  const SILENCE_MS = 1200;
  const LISTEN_GRACE_MS = 1500;
  const MAX_LISTEN_MS = 60000;
  const audioRecorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  const anonRef = useRef(null);
  const convRef = useRef(null);
  const authBusyRef = useRef(false);
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  // Set after a successful sign-in rebind that followed a real pre-auth
  // conversation. Consumed once by the resume effect below.
  const resumeRef = useRef(false);
  // Registration signs the user in on purpose, so its welcome line replaces
  // the generic "continue what we were doing" resume turn.
  const skipResumeRef = useRef(false);
  // A registration is followed by one model-generated greeting, even when the
  // user never spoke to the assistant before signing up.
  const welcomeRef = useRef(false);
  const [welcomeTick, setWelcomeTick] = useState(0);
  // Resolves when the post-sign-in conversation rebind settles, so the greeting
  // turn never races the anonymous conversation being attached to the account.
  const rebindPromiseRef = useRef(Promise.resolve());
  const authRef = useRef({ ready: authReady, isAuthenticated });
  authRef.current = { ready: authReady, isAuthenticated };
  // Screen context from the last turn, used to avoid opening the chat when the
  // user is already in that thread.
  const lastContextRef = useRef(null);

  const ensureConversation = useCallback(async () => {
    if (convRef.current) return convRef.current;

    const authed = authRef.current.isAuthenticated;
    let anonymousId = anonRef.current;
    if (!authed && !anonymousId) {
      anonymousId = await AsyncStorage.getItem(ANON_KEY).catch(() => null);
      anonRef.current = anonymousId || null;
    }

    const res = await createConversation({
      anonymousId: authed ? undefined : (anonymousId || undefined),
    });
    if (!res?.success || !res?.conversationId) throw new Error('conv_create_failed');

    if (!authed && res.anonymousId) {
      anonRef.current = res.anonymousId;
      AsyncStorage.setItem(ANON_KEY, res.anonymousId).catch(() => {});
    }

    convRef.current = res.conversationId;
    setConversationId(res.conversationId);
    return res.conversationId;
  }, []);

  // Wait for auth to resolve before creating a conversation, so a fresh
  // authenticated launch does not create an anonymous conversation first.
  useEffect(() => {
    if (!authReady) return undefined;
    let mounted = true;
    (async () => {
      try {
        await ensureConversation();
      } catch (e) {
        if (mounted) { setStatus('error'); setError(e); }
      } finally {
        if (mounted) setIsReady(true);
      }
    })();
    return () => { mounted = false; };
  }, [authReady, ensureConversation]);

  // Rebind on the false→true transition of isAuthenticated.
  const prevAuthRef = useRef(isAuthenticated);
  useEffect(() => {
    if (!authReady) return;
    if (prevAuthRef.current === isAuthenticated) return;
    prevAuthRef.current = isAuthenticated;

    if (isAuthenticated) {
      const anonymousId = anonRef.current;
      const cid = convRef.current;
      if (!anonymousId || !cid) {
        // Nothing to rebind. A registration greeting still runs on the new
        // signed-in conversation.
        rebindPromiseRef.current = Promise.resolve();
        return;
      }
      // Only resume when the user was already talking before signing in. A
      // registration always greets, even with no chat history.
      const hadConversation = messagesRef.current.some(m => m && m.role === 'user');
      rebindPromiseRef.current = (async () => {
        try {
          await rebindConversation({ conversationId: cid, anonymousId });
          anonRef.current = null;
          AsyncStorage.removeItem(ANON_KEY).catch(() => {});
          if (hadConversation && !skipResumeRef.current) resumeRef.current = true;
          skipResumeRef.current = false;
        } catch (_e) {
          // 404 means the anonymous id was lost or belongs to another
          // conversation. Start clean instead of leaving the session stuck.
          convRef.current = null;
          anonRef.current = null;
          setConversationId(null);
          AsyncStorage.removeItem(ANON_KEY).catch(() => {});
          try { await ensureConversation(); } catch (_e2) { /* surfaced on first send */ }
        }
      })();
    } else {
      rebindPromiseRef.current = Promise.resolve();
      convRef.current = null;
      anonRef.current = null;
      setConversationId(null);
      setMessages([]);
      setStatus('idle');
      setError(null);
      setLastVoice(null);
      stopSpeaking();
      AsyncStorage.removeItem(ANON_KEY).catch(() => {});
    }
  }, [authReady, isAuthenticated, ensureConversation]);

  // Runs the single `navigate` block a turn may return. Voice and text both
  // use this path, so "open my messages" also works from the global mic. The
  // screen opens after the reply is already in `messages`, so a form screen
  // that mounts next can read its fill_* patch (see useAIPatch).
  const runNavigation = useCallback((structured) => {
    const blocks = Array.isArray(structured) ? structured : [];
    let target = null;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i];
      if (b && b.type === 'navigate' && typeof b.target === 'string') { target = b; break; }
    }
    if (!target || !NAVIGABLE_SCREENS.has(target.target)) return null;

    const query = typeof target.query === 'string' ? target.query.trim().slice(0, 120) : '';
    const params = query ? { query } : {};
    if (PANEL_ROUTES.has(target.target)) nav.selectTab(target.target, params);
    else nav.push(target.target, params);
    return target.target;
  }, [nav]);

  // Shared tail of every successful turn: queue the assistant message, then
  // run navigation and the seller-chat handoff. Used by the single-reply path
  // and the streamed path alike, so both behave identically once the turn data
  // is in.
  const finishTurn = useCallback((res, context) => {
    const reply = res.reply || '';
    setMessages(prev => [...prev, {
      key: newKey(),
      role: 'assistant',
      text: reply,
      structured: res.structured || null,
      confirmation: res.confirmation_required || null,
      at: Date.now(),
    }]);
    setStatus('idle');

    // Move after the assistant message is queued, so a screen that mounts
    // because of this call already sees its fill_* patch.
    const navigatedTo = runNavigation(res.structured);

    // Seller-chat handoff: the user agreed to message the seller, so carry
    // them to the chat with the draft pre-filled, unless they are already in
    // that thread (context.chatPartnerId matches). The block carries ids and
    // display text only, and the id shape is checked again here.
    let handoffTo = null;
    if (Array.isArray(res.structured)) {
      const h = res.structured.find(b => b && b.type === 'chat_handoff' && b.sellerId);
      if (h
        && /^[a-fA-F0-9]{24}$/.test(String(h.sellerId))
        && String(context?.chatPartnerId || '') !== String(h.sellerId)) {
        handoffTo = 'chat';
        nav.push('chat', {
          partnerId: String(h.sellerId),
          ...(h.sellerName ? { name: String(h.sellerName).slice(0, 80) } : {}),
          ...(h.draft ? { draft: String(h.draft).slice(0, 500) } : {}),
          ...((h.productId || h.imageUrl || h.productTitle) ? {
            product: {
              ...(h.productId ? { productId: String(h.productId) } : {}),
              ...(h.productTitle ? { title: String(h.productTitle).slice(0, 120) } : {}),
              ...(h.imageUrl ? { imageUrl: String(h.imageUrl).slice(0, 2048) } : {}),
              ...(typeof h.price === 'number' ? { price: h.price } : {}),
            },
          } : {}),
        });
      }
    }

    return {
      ok: true,
      reply,
      structured: res.structured || null,
      confirmation: res.confirmation_required || null,
      navigatedTo: handoffTo || navigatedTo,
    };
  }, [runNavigation, nav]);

  // Streams one turn: each sentence renders in the chat and is spoken the
  // moment it arrives, so the user hears the answer starting while the turn
  // still completes. Returns null when nothing was heard, so the caller runs
  // the single-reply path instead. A partial stream keeps what was heard and
  // finishes the turn from it rather than failing.
  const sendStreamedTurn = useCallback(async ({ cid, clean, anonId, turnContext, context }) => {
    const streamKey = newKey();
    let full = '';
    let heard = 0;
    setMessages(prev => [...prev, { key: streamKey, role: 'assistant', text: '', streaming: true, at: Date.now() }]);
    try {
      const res = await sendTurnStream({
        conversationId: cid,
        message: clean,
        anonymousId: anonId,
        context: turnContext,
        onSentence: (sentence) => {
          heard += 1;
          full = full ? `${full} ${sentence}` : sentence;
          setMessages(prev => prev.map(m => (
            m.key === streamKey ? { ...m, text: full } : m
          )));
          queueSpeech(sentence);
        },
      });
      if (!res?.success) throw new Error(res?.message || 'turn_failed');
      // Swap the live placeholder for the exact server text, then run the
      // shared tail (navigation, handoff) once.
      setMessages(prev => prev.filter(m => m.key !== streamKey));
      const out = finishTurn(res, context);
      return { ...out, spoken: true };
    } catch (_e) {
      if (!heard) {
        setMessages(prev => prev.filter(m => m.key !== streamKey));
        return null;
      }
      setMessages(prev => prev.map(m => (
        m.key === streamKey ? { ...m, streaming: false } : m
      )));
      setStatus('idle');
      return { ok: true, reply: full, structured: null, confirmation: null, navigatedTo: null, spoken: true, partial: true };
    }
  }, [finishTurn]);

  const send = useCallback(async (text, context, opts) => {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'empty', message: 'I did not catch that.' };
    if (status === 'sending') {
      return { ok: false, code: 'busy', message: 'One moment — I am still working on the last request.' };
    }
    lastContextRef.current = context || null;

    // Carry a real auth outcome code from the screen (401/403/429/offline)
    // into this turn. Only the fixed code travels, never the server text.
    // The listing snapshot follows the same rule: flags only, never values.
    const authOutcome = takeAuthOutcome();
    const listing = peekFormSnapshot();
    // Registration flags belong to the register screen. Once the user moves
    // away, the old form state must not ride along with an unrelated turn.
    const registration = context?.screen === 'register' ? peekRegistrationSnapshot() : null;
    const turnContext = (authOutcome || listing || registration)
      ? {
        ...(context || {}),
        ...(authOutcome ? { authOutcome } : {}),
        ...(listing ? { listing } : {}),
        ...(registration ? { registration } : {}),
      }
      : (context || undefined);
    if (authOutcome || listing || registration) lastContextRef.current = turnContext;

    setStatus('sending');
    setError(null);
    setMessages(prev => [...prev, { key: newKey(), role: 'user', text: clean, at: Date.now() }]);

    try {
      const cid = await ensureConversation();
      const anonId = authRef.current.isAuthenticated ? undefined : (anonRef.current || undefined);
      // A streamed turn speaks each sentence the moment it arrives, so the
      // user hears the answer starting while the turn is still completing.
      // Anything unexpected falls back to the single-reply path below.
      if (opts?.streamSpeech && typeof sendTurnStream === 'function') {
        const streamed = await sendStreamedTurn({
          cid, clean, anonId, turnContext, context,
        });
        if (streamed) return streamed;
      }
      const res = await sendTurn({
        conversationId: cid,
        message: clean,
        anonymousId: anonId,
        context: turnContext,
      });
      if (!res?.success) throw new Error(res?.message || 'turn_failed');

      return finishTurn(res, context);
    } catch (e) {
      setError(e);
      setStatus('error');
      const human = e?.isNetwork
        ? 'No internet connection. Check your network and try again.'
        : 'The assistant is temporarily unavailable. Please try again.';
      setMessages(prev => [...prev, { key: newKey(), role: 'assistant', kind: 'error', text: human, at: Date.now() }]);
      return { ok: false, code: 'error', error: e, message: human };
    }
  }, [status, ensureConversation, runNavigation, nav, finishTurn, sendStreamedTurn]);

  // Resume the pre-auth request once, right after a rebind that followed a
  // real conversation. The line is truthful (they did just sign in), and the
  // server still holds the task goal on the same conversation, so the assistant
  // continues instead of asking the user to repeat themselves. It is spoken
  // aloud so the user does not have to open the AI screen to hear it.
  useEffect(() => {
    if (!resumeRef.current || !authReady || !isAuthenticated) return;
    resumeRef.current = false;
    (async () => {
      try {
        const result = await send('I just signed in. Please continue with what we were doing.');
        const line = result.ok
          ? (result.reply || 'Done.')
          : (result.message || 'You are signed in.');
        setLastVoice({ text: line, kind: result.ok ? 'reply' : 'error', at: Date.now() });
        await speakReply(line);
      } catch (_e) { /* nothing stuck — the user can still talk */ }
    })();
  }, [authReady, isAuthenticated, send]);

  // A newly created account gets one model-written greeting. The turn carries
  // an event marker, not form values: the server tells the model the account
  // exists and the user is signed in, so the reply cannot drift back into
  // registration questions. The fixed line is only a fallback when the model
  // is unreachable.
  useEffect(() => {
    if (!welcomeRef.current || !authReady || !isAuthenticated) return;
    welcomeRef.current = false;
    (async () => {
      const fallback =
        'Welcome to Salmart, we are glad to have you here. Would you like to buy or sell something?';
      try {
        await rebindPromiseRef.current.catch(() => {});
        // The screen's completion flags are stale now that the account exists.
        takeRegistrationSnapshot();
        const result = await send('I just created my account.', {
          event: 'registration_complete',
          screen: 'market',
        });
        const line = result.ok && result.reply ? result.reply : fallback;
        setLastVoice({ text: line, kind: result.ok ? 'reply' : 'error', at: Date.now() });
        await speakReply(line);
      } catch (_e) {
        setLastVoice({ text: fallback, kind: 'reply', at: Date.now() });
        try { await speakReply(fallback); } catch (_e2) { /* speech is optional */ }
      }
    })();
  }, [welcomeTick, authReady, isAuthenticated, send]);

  /**
   * Touch-to-buy. The buyer tapped a product card; send that exact productId
   * to the deterministic server route, queue the confirmation in the chat,
   * and speak the price and description. No model call, so the confirmation
   * arrives immediately and cannot drift to another product.
   */
  const selectProduct = useCallback(async (product) => {
    const productId = product?.productId || product?._id;
    if (!productId) {
      return { ok: false, code: 'BAD_PRODUCT', message: 'That item could not be found.' };
    }

    if (!authRef.current.isAuthenticated) {
      const line = 'Please sign in first, then touch the item again.';
      setMessages(prev => [...prev, {
        key: newKey(), role: 'assistant', kind: 'error', text: line, at: Date.now(),
      }]);
      setLastVoice({ text: line, kind: 'error', at: Date.now() });
      await speakReply(line);
      return { ok: false, code: 'AUTH_REQUIRED', message: line };
    }

    try {
      const cid = conversationId || await ensureConversation().catch(() => null);
      const res = await selectProductToCart({
        productId,
        itemType: product.itemType === 'showroom' ? 'showroom' : 'post',
        conversationId: cid || undefined,
      });
      if (!res?.success) throw new Error(res?.message || 'Could not add it to your cart.');

      const line = res.reply || 'I added it to your cart.';
      const blocks = Array.isArray(res.structured) ? res.structured : [];
      setMessages(prev => [...prev, {
        key: newKey(),
        role: 'assistant',
        text: line,
        structured: blocks,
        at: Date.now(),
      }]);
      const added = blocks.find(b => b && b.type === 'product_added');
      setLastVoice({
        text: line,
        kind: 'reply',
        chatHandoff: added?.chat || null,
        at: Date.now(),
      });
      await speakReply(line);
      return { ok: true, ...res };
    } catch (e) {
      const code = e?.status === 401 ? 'AUTH_REQUIRED' : (e?.code || 'CART_FAILED');
      const line = e?.status === 401
        ? 'Please sign in first, then touch the item again.'
        : e?.isNetwork
          ? 'No internet connection. Please try again.'
          : (e?.message || 'I could not add that item. Please touch another one.');
      setMessages(prev => [...prev, {
        key: newKey(), role: 'assistant', kind: 'error', text: line, at: Date.now(),
      }]);
      setLastVoice({ text: line, kind: 'error', at: Date.now() });
      await speakReply(line);
      return { ok: false, code, message: line };
    }
  }, [conversationId, ensureConversation]);

  const confirm = useCallback(async (actionId) => {
    try {
      const res = await apiConfirm(actionId);
      const r = res?.result || {};
      setMessages(prev => {
        const cleared = prev.map(m => (
          m.confirmation?.actionId === actionId ? { ...m, confirmation: null } : m
        ));
        cleared.push({ key: newKey(), role: 'assistant', text: 'Done. That action is complete.', at: Date.now() });
        return cleared;
      });
      // A confirmed seller enquiry was sent by the server. Open that chat
      // unless the user is already there (the last turn context matches).
      if (r.sellerId
        && /^[a-fA-F0-9]{24}$/.test(String(r.sellerId))
        && String(lastContextRef.current?.chatPartnerId || '') !== String(r.sellerId)) {
        nav.push('chat', {
          partnerId: String(r.sellerId),
          ...(r.sellerName ? { name: String(r.sellerName).slice(0, 80) } : {}),
          ...((r.productId || r.productImageUrl) ? {
            product: {
              ...(r.productId ? { productId: String(r.productId) } : {}),
              ...(r.productImageUrl ? { imageUrl: String(r.productImageUrl).slice(0, 2048) } : {}),
            },
          } : {}),
        });
      }
      return { ok: true, result: res?.result };
    } catch (e) {
      let human = 'Could not complete that action. Please try again.';
      if (e?.status === 409) human = 'That action was already applied.';
      else if (e?.status === 410) human = 'That action expired. Please ask again.';
      else if (e?.status === 400) human = e?.message || 'That action could not be completed.';
      else if (e?.isNetwork) human = 'No internet connection. Please try again.';
      setMessages(prev => [...prev, { key: newKey(), role: 'assistant', kind: 'error', text: human, at: Date.now() }]);
      return { ok: false, error: e, message: human };
    }
  }, [nav]);

  const cancel = useCallback(async (actionId) => {
    try { await apiCancel(actionId); } catch (_e) { /* idempotent — ignore */ }
    setMessages(prev => prev.map(m => (
      m.confirmation?.actionId === actionId ? { ...m, confirmation: null } : m
    )));
    return { ok: true };
  }, []);

  // Voice variants used by the global mic card. They perform the action and
  // speak the outcome, so the user does not have to open the AI screen.
  // A confirmed seller enquiry already opened the chat above, so the line
  // says where the user is.
  const confirmVoice = useCallback(async (actionId) => {
    const res = await confirm(actionId);
    const sentToSeller = res?.ok && res?.result?.sellerId;
    const line = res?.ok
      ? (sentToSeller
        ? `Sent. You are now in the chat with ${res.result.sellerName || 'the seller'}.`
        : 'Done. That action is complete.')
      : (res?.message || 'I could not complete that action.');
    setLastVoice({ text: line, kind: res?.ok ? 'reply' : 'error', at: Date.now() });
    await speakReply(line);
    return res;
  }, [confirm]);

  const cancelVoice = useCallback(async (actionId) => {
    await cancel(actionId);
    const line = 'Okay, I cancelled that.';
    setLastVoice({ text: line, kind: 'reply', at: Date.now() });
    await speakReply(line);
    return { ok: true };
  }, [cancel]);

  const dismissVoice = useCallback(() => setLastVoice(null), []);

  /** Show a short status in the global card, optionally speaking it. */
  const notice = useCallback(async (text, { speak: shouldSpeak = false, kind = 'reply' } = {}) => {
    const line = String(text || '').trim();
    if (!line) return;
    setLastVoice({ text: line, kind, at: Date.now() });
    if (shouldSpeak) await speakReply(line);
  }, []);

  /** Speak an arbitrary line, used by the "hear this" buttons. */
  const speak = useCallback(async (text) => {
    await speakReply(text);
  }, []);

  /**
   * Mark the next false→true auth transition as a registration: the generic
   * resume turn is skipped and the assistant writes one welcome instead. Pass
   * false when registration failed, so a later sign-in still resumes.
   */
  const welcomeAfterRegistration = useCallback((on = true) => {
    const wanted = on !== false;
    welcomeRef.current = wanted;
    skipResumeRef.current = wanted;
    if (wanted) setWelcomeTick(t => t + 1);
  }, []);

  /**
   * Google sign-in handoff.
   *
   * Preferred path: the native account picker (runGoogleAuth) returns an
   * idToken, which the backend verifies. Fallback: open the server-built
   * initiation URL in a system browser for Expo Go, a build without the native
   * module, or any native failure. The assistant never sees a Google password.
   *
   * `url` is the gated URL from the backend's `auth_url` block. `ref` is read
   * from it so a new account still records its referrer.
   */
  const startGoogleAuth = useCallback(async ({ url, platform } = {}) => {
    if (authBusyRef.current) return { ok: false, code: 'busy' };
    if (authRef.current.isAuthenticated) {
      const line = 'You are already signed in.';
      setLastVoice({ text: line, kind: 'reply', at: Date.now() });
      await speakReply(line);
      return { ok: true, alreadySignedIn: true };
    }

    authBusyRef.current = true;
    setAuthBusy(true);
    try {
      const { status, params } = await runGoogleAuth({
        forceAccountPicker: true,
        ref: referralFromUrl(url),
      });

      if (status === 'cancelled') return { ok: false, code: 'cancelled' };

      if (status === 'setup') {
        nav.push('completeProfile', {
          setup_token: params.setup_token,
          email: params.email,
          firstName: params.firstName,
          lastName: params.lastName,
          profilePicture: params.profilePicture,
        });
        return { ok: true, status };
      }

      if (status === 'ok') {
        await adoptWebSession({
          authToken: params.token,
          userId: params.userId,
          email: params.email,
          firstName: params.firstName,
          lastName: params.lastName,
          profilePicture: params.profilePicture,
        });
        const line = 'You are signed in.';
        setLastVoice({ text: line, kind: 'reply', at: Date.now() });
        await speakReply(line);
        return { ok: true, status };
      }

      const line = 'Google did not finish signing you in. Please try again.';
      setLastVoice({ text: line, kind: 'error', at: Date.now() });
      await speakReply(line);
      return { ok: false, code: 'incomplete' };
    } catch (e) {
      // Expo Go, a missing native module or a native failure: use the server
      // URL instead of dead-ending the user. The URL is https and was checked
      // by the backend before it reached this block.
      if (url) {
        try {
          await WebBrowser.openBrowserAsync(url);
          return { ok: true, status: 'browser' };
        } catch (_browserErr) {
          try {
            await Linking.openURL(url);
            return { ok: true, status: 'browser' };
          } catch (_linkErr) { /* fall through to the spoken error */ }
        }
      }

      const line = e?.isNetwork
        ? 'No internet connection. Please try again.'
        : 'I could not start Google sign-in. Please try again.';
      setLastVoice({ text: line, kind: 'error', at: Date.now() });
      await speakReply(line);
      return { ok: false, code: 'error', error: e, platform };
    } finally {
      authBusyRef.current = false;
      setAuthBusy(false);
    }
  }, [nav, adoptWebSession]);

  const reset = useCallback(async () => {
    convRef.current = null;
    setConversationId(null);
    setMessages([]);
    setStatus('idle');
    setError(null);
    setLastVoice(null);
    stopSpeaking();
    if (!authRef.current.isAuthenticated) {
      anonRef.current = null;
      await AsyncStorage.removeItem(ANON_KEY).catch(() => {});
    }
    try { await ensureConversation(); } catch (_e) { /* surfaced on first send */ }
  }, [ensureConversation]);

  // Stop any speech when the provider goes away (logout, hot reload).
  useEffect(() => () => { stopSpeaking(); }, []);

  /**
   * Stop the recording and run one voice turn: upload, transcribe, answer and
   * speak. Shared by the manual second tap and the silence auto-stop.
   */
  const stopVoiceTurn = useCallback(async (context) => {
    setRecording(false);
    setTranscribing(true);
    let heardLang = null;
    try {
      await audioRecorder.stop();
      // Leave the recording audio session so the reply plays on the speaker.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = audioRecorder.uri;
      if (!uri) throw new Error('no_recording');

      const form = new FormData();
      form.append('audio', { uri, name: 'voice.m4a', type: 'audio/m4a' });
      const res = await apiUpload('/api/assistant/transcribe', form);
      const transcript = String(res?.text || '').trim();
      // The reply, in text and voice, follows the speaker's language.
      heardLang = (res && typeof res.lang === 'string' && res.lang !== 'eng') ? res.lang : null;

      if (!res?.success || !transcript) {
        const line = 'I could not catch that. Please try again.';
        setTranscribing(false);
        setLastVoice({ text: line, kind: 'error', at: Date.now() });
        await speakReply(line, heardLang);
        return;
      }

      // The card shows "Thinking…" while the turn runs. The turn streams: each
      // sentence speaks as it arrives, so `spoken` means there is nothing
      // left to say at the end.
      setTranscribing(false);
      const turnContext = { ...(context || {}), ...(heardLang ? { lang: heardLang } : {}) };
      const result = await send(transcript, turnContext, { streamSpeech: true });
      const line = result.ok
        ? (result.reply || 'Done.')
        : (result.message || 'The assistant is temporarily unavailable. Please try again.');

      // Keep a Google sign-in action tappable without leaving the current
      // screen, so the gated block travels into the card as well as AI Mode.
      // The same applies to a seller-chat handoff when auto-open was missed.
      const authBlock = result.ok && Array.isArray(result.structured)
        ? result.structured.find(b => b && b.type === 'auth_url' && b.url)
        : null;
      const chatBlock = result.ok && Array.isArray(result.structured)
        ? result.structured.find(b => b && b.type === 'chat_handoff' && b.sellerId)
        : null;
      // A search returns products for the touch picker. The floating mic keeps
      // the block so a voice turn started on Market opens the same sheet as a
      // turn inside AI Mode.
      const productBlock = result.ok && Array.isArray(result.structured)
        ? result.structured.find(b => b && b.type === 'product_results'
          && Array.isArray(b.products) && b.products.length)
        : null;

      setLastVoice({
        text: line,
        kind: result.ok ? 'reply' : 'error',
        confirmation: result.ok ? (result.confirmation || null) : null,
        authUrl: authBlock || null,
        chatHandoff: chatBlock || null,
        products: productBlock || null,
        at: Date.now(),
      });
      if (!result.spoken) await speakReply(line, heardLang);
    } catch (e) {
        const line = e?.status === 401
          ? 'Your session has expired. Please sign in again.'
          : e?.isNetwork
            ? 'No internet connection. Please try again.'
            : 'I could not hear that. Please try again.';
        setLastVoice({ text: line, kind: 'error', at: Date.now() });
        await speakReply(line, heardLang);
      } finally {
        setTranscribing(false);
      }
      return;
    },
    [audioRecorder, send],
  );

  // Context the recording started with. The silence auto-stop reuses it
  // because there is no fresh tap to read it from.
  const startContextRef = useRef(null);

  // Poll the mic level while recording. This stops once per recording, only
  // after speech was heard and the grace period has passed. If the device has
  // no metering or the room never falls quiet, the user stops manually.
  useEffect(() => {
    if (!recording) return undefined;
    const startedAt = Date.now();
    let silentSince = null;
    let heardVoice = false;
    let fired = false;
    const id = setInterval(() => {
      if (fired) return;
      let metering;
      try {
        metering = audioRecorder.getStatus()?.metering;
      } catch (_e) {
        return;
      }
      const now = Date.now();
      if (now - startedAt > MAX_LISTEN_MS) {
        fired = true;
        stopVoiceTurn(startContextRef.current);
        return;
      }
      if (typeof metering !== 'number') return;
      if (metering > SILENCE_DB) {
        heardVoice = true;
        silentSince = null;
        return;
      }
      if (!heardVoice || now - startedAt < LISTEN_GRACE_MS) return;
      if (silentSince == null) {
        silentSince = now;
        return;
      }
      if (now - silentSince >= SILENCE_MS) {
        fired = true;
        stopVoiceTurn(startContextRef.current);
      }
    }, 200);
    return () => clearInterval(id);
  }, [recording, audioRecorder, stopVoiceTurn, SILENCE_DB, SILENCE_MS, LISTEN_GRACE_MS, MAX_LISTEN_MS]);

  /**
   * Start or stop one voice turn from the global mic.
   *
   * `context` is the shallow screen hint sent with the turn, matching the
   * contract used by AIModeScreen. The turn, its tool actions and the spoken
   * reply all happen on the current screen. Tapping while recording stops
   * manually; staying silent stops automatically.
   */
  const toggleRecording = useCallback(async (context) => {
    if (transcribing) return;

    if (recording) {
      await stopVoiceTurn(context);
      return;
    }

    // Start a new recording.
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setLastVoice({ text: 'Please allow microphone access to talk to me.', kind: 'error', at: Date.now() });
        return;
      }
      // Do not record over a reply that is still playing.
      await stopSpeaking();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setLastVoice(null);
      setMicNudge(null);
      startContextRef.current = context || null;
      setRecording(true);
    } catch (err) {
      setLastVoice({ text: 'I could not start listening. Please try again.', kind: 'error', at: Date.now() });
    }
  }, [recording, transcribing, send, audioRecorder, stopVoiceTurn]);

  // Pulse the mic button and optionally show a label ("Tap to talk"). The user
  // still taps to start recording.
  const nudgeMic = useCallback((label) => {
    setMicNudge({ key: `nudge-${Date.now()}`, label: String(label || 'Tap to talk').slice(0, 40) });
  }, []);

  // Seller-chat handoff: open ChatScreen with the AI draft and product card
  // pre-filled. The user presses send in the chat; nothing is auto-sent.
  const openSellerChat = useCallback((handoff) => {
    if (!handoff?.sellerId) return;
    nav.push('chat', {
      partnerId: String(handoff.sellerId),
      ...(handoff.sellerName ? { name: String(handoff.sellerName).slice(0, 80) } : {}),
      ...(handoff.draft ? { draft: String(handoff.draft).slice(0, 500) } : {}),
      ...((handoff.productId || handoff.imageUrl || handoff.productTitle) ? {
        product: {
          ...(handoff.productId ? { productId: String(handoff.productId) } : {}),
          ...(handoff.productTitle ? { title: String(handoff.productTitle).slice(0, 120) } : {}),
          ...(handoff.imageUrl ? { imageUrl: String(handoff.imageUrl).slice(0, 2048) } : {}),
          ...(typeof handoff.price === 'number' ? { price: handoff.price } : {}),
        },
      } : {}),
    });
  }, [nav]);

  const value = useMemo(() => ({
    conversationId, messages, status, error, isReady, recording, transcribing,
    lastVoice, toggleRecording, dismissVoice, confirmVoice, cancelVoice,
    send, selectProduct, confirm, cancel, reset, openSellerChat, micNudge, nudgeMic,
    startGoogleAuth, authBusy, notice, speak, welcomeAfterRegistration,
  }), [
    conversationId, messages, status, error, isReady, send, selectProduct, confirm, cancel, reset,
    recording, transcribing, toggleRecording, lastVoice, dismissVoice, confirmVoice, cancelVoice,
    openSellerChat, micNudge, nudgeMic,
    startGoogleAuth, authBusy, notice, speak, welcomeAfterRegistration,
  ]);

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI() {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error('useAI must be used inside <AIProvider>.');
  return ctx;
}