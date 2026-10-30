/**
 * Salmart AI Mode — state provider
 *
 * Owns the /api/ai/* conversation lifecycle. Independent of AssistantContext
 * (which still drives the old form-fill bridge in CreateAd / CreateRequest /
 * EditProfile / Cart until cycle 2).
 *
 * Persistence:
 *   - anonymousId in AsyncStorage under `salmart:ai:anonymousId`. Not secret
 *     (a client-held identity token) so AsyncStorage matches AuthContext
 *     conventions rather than SecureStore.
 *   - Conversation history is on the backend. The local `messages` array is a
 *     render cache; `reset()` clears it and starts a fresh conversation.
 *
 * Sign-in rebind:
 *   - On `isAuthenticated: false → true`, POSTs /conversations/rebind with the
 *     stored anonymousId so the same conversation carries forward. On 404
 *     (mismatched / lost anon), starts a fresh conversation silently.
 *   - When the rebind follows a real pre-auth conversation, one resume turn
 *     ("I just signed in…") runs and is spoken, so the stranded intention
 *     continues. A manual sign-in with no AI history stays silent.
 *   - On sign-out, everything is cleared locally so the next identity starts
 *     empty — no cross-user leakage.
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
  createConversation, rebindConversation, sendTurn,
  confirmAction as apiConfirm, cancelAction as apiCancel,
} from './api';
import { speakReply, stopSpeaking } from './speak';

const ANON_KEY = 'salmart:ai:anonymousId';

// Server-side allowlist mirror (services/ai/tools/navigationTools.js). The
// server only emits `navigate` for these keys; the client re-checks so a
// malformed/forged response can never push an unknown or AI route.
const NAVIGABLE_SCREENS = new Set([
  'market', 'requests', 'alerts', 'messages', 'deals', 'profile',
  'search', 'cart', 'referral', 'createAd', 'createRequest', 'editProfile',
  'ads', 'promote', 'showrooms', 'vtu',
  'register', 'signin', 'passwordReset',
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
  // What the global mic overlay shows / spoke last. Null when there is nothing
  // to show. `confirmation` keeps the turn's Confirm/Cancel available inline.
  const [lastVoice, setLastVoice] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const anonRef = useRef(null);
  const convRef = useRef(null);
  const authBusyRef = useRef(false);
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  // Set when a sign-in rebind succeeds after a real pre-auth conversation;
  // consumed once by the resume effect below.
  const resumeRef = useRef(false);
  const authRef = useRef({ ready: authReady, isAuthenticated });
  authRef.current = { ready: authReady, isAuthenticated };
  // Last turn's screen context — so a confirmed seller enquiry does not push
  // the chat when the user is already standing in that exact thread.
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

  // Boot: wait for auth ready so a fresh authenticated launch never creates an
  // anonymous conversation it would immediately discard.
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
      if (!anonymousId || !cid) return;
      // Only resume when the user was actually talking before signing in —
      // a manual sign-in with no AI history must stay silent.
      const hadConversation = messagesRef.current.some(m => m && m.role === 'user');
      (async () => {
        try {
          await rebindConversation({ conversationId: cid, anonymousId });
          anonRef.current = null;
          AsyncStorage.removeItem(ANON_KEY).catch(() => {});
          if (hadConversation) resumeRef.current = true;
        } catch (_e) {
          // 404 = lost / mismatched — start clean rather than leave it stuck.
          convRef.current = null;
          anonRef.current = null;
          setConversationId(null);
          AsyncStorage.removeItem(ANON_KEY).catch(() => {});
          try { await ensureConversation(); } catch (_e2) { /* surfaced on first send */ }
        }
      })();
    } else {
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

  // Execute the single `navigate` block a turn may return. Voice and text both
  // go through here, so "open my messages" works from the global mic without
  // ever pushing the AI screen. The screen is opened only after the reply is
  // already in `messages`, so a form screen that mounts next can read its
  // fill_* patch synchronously (see useAIPatch).
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

  const send = useCallback(async (text, context) => {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'empty', message: 'I did not catch that.' };
    if (status === 'sending') {
      return { ok: false, code: 'busy', message: 'One moment — I am still working on the last request.' };
    }
    lastContextRef.current = context || null;

    setStatus('sending');
    setError(null);
    setMessages(prev => [...prev, { key: newKey(), role: 'user', text: clean, at: Date.now() }]);

    try {
      const cid = await ensureConversation();
      const res = await sendTurn({
        conversationId: cid,
        message: clean,
        anonymousId: authRef.current.isAuthenticated ? undefined : (anonRef.current || undefined),
        context: context || undefined,
      });
      if (!res?.success) throw new Error(res?.message || 'turn_failed');

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

      // Move only after the assistant message is queued, so a screen that
      // mounts because of this call already sees its fill_* patch.
      const navigatedTo = runNavigation(res.structured);

      // Seller-chat handoff: the user agreed to message the seller, so carry
      // them to the chat with the draft pre-filled — unless they are already
      // standing in that exact thread (context.chatPartnerId matches).
      // The block carries only ids + display text; re-check the id shape.
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
    } catch (e) {
      setError(e);
      setStatus('error');
      const human = e?.isNetwork
        ? 'No internet connection. Check your network and try again.'
        : 'The assistant is temporarily unavailable. Please try again.';
      setMessages(prev => [...prev, { key: newKey(), role: 'assistant', kind: 'error', text: human, at: Date.now() }]);
      return { ok: false, code: 'error', error: e, message: human };
    }
  }, [status, ensureConversation, runNavigation, nav]);

  // Resume the pre-auth intention once, right after a rebind that followed a
  // real conversation. The line is truthful (they did just sign in) and the
  // server still holds the task goal on the same conversation, so the model
  // continues instead of asking them to repeat themselves. Spoken aloud: a
  // non-reading user never has to find the AI screen to hear it.
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
      // A confirmed seller enquiry was sent server-side: carry the user to
      // that chat — unless they are already in it (last turn context matches).
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

  // Voice variants used by the global mic overlay: do the action and say the
  // outcome out loud, so the user never has to open the AI screen.
  // A confirmed seller enquiry already pushed the chat above; say where they are.
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

  /** Speak an arbitrary line (used by "hear this" affordances). */
  const speak = useCallback(async (text) => {
    await speakReply(text);
  }, []);

  /**
   * Google handoff.
   *
   * Preferred: the native account picker (runGoogleAuth), which returns an
   * idToken the backend verifies. Fallback: the server-built initiation URL in
   * a system browser, for Expo Go / a build without the native module / any
   * native failure. Either way the AI never sees a Google password.
   *
   * `url` is the gated URL from the backend's `auth_url` block; `ref` is only
   * read out of it so a brand-new account still links its referrer.
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
      // Expo Go / missing native module / native failure: use the server URL
      // rather than dead-ending the user. The URL is https and was re-checked
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
   * Global mic: start/stop one voice turn.
   *
   * `context` is the shallow screen hint sent with the turn (same contract as
   * AIModeScreen's text sends). The turn, the tool actions it triggers, and the
   * spoken reply all happen where the user already is — nothing navigates.
   */
  const toggleRecording = useCallback(async (context) => {
    if (transcribing) return;

    if (recording) {
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
        // The speaker's own language: the reply (text and voice) mirrors it.
        heardLang = (res && typeof res.lang === 'string' && res.lang !== 'eng') ? res.lang : null;

        if (!res?.success || !transcript) {
          const line = 'I could not catch that. Please try again.';
          setTranscribing(false);
          setLastVoice({ text: line, kind: 'error', at: Date.now() });
          await speakReply(line, heardLang);
          return;
        }

        // Show "Thinking…" rather than "Transcribing…" while the turn runs.
        setTranscribing(false);
        const turnContext = { ...(context || {}), ...(heardLang ? { lang: heardLang } : {}) };
        const result = await send(transcript, turnContext);
        const line = result.ok
          ? (result.reply || 'Done.')
          : (result.message || 'The assistant is temporarily unavailable. Please try again.');

        // A Google handoff must be tappable without leaving the current screen,
        // so carry the gated block into the card instead of only into AI Mode.
        // Same for a seller-chat handoff (fallback if the auto-open was missed).
        const authBlock = result.ok && Array.isArray(result.structured)
          ? result.structured.find(b => b && b.type === 'auth_url' && b.url)
          : null;
        const chatBlock = result.ok && Array.isArray(result.structured)
          ? result.structured.find(b => b && b.type === 'chat_handoff' && b.sellerId)
          : null;

        setLastVoice({
          text: line,
          kind: result.ok ? 'reply' : 'error',
          confirmation: result.ok ? (result.confirmation || null) : null,
          authUrl: authBlock || null,
          chatHandoff: chatBlock || null,
          at: Date.now(),
        });
        await speakReply(line, heardLang);
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
    }

    // START RECORDING
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setLastVoice({ text: 'Please allow microphone access to talk to me.', kind: 'error', at: Date.now() });
        return;
      }
      // Never record over a reply that is still playing.
      await stopSpeaking();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setLastVoice(null);
      setRecording(true);
    } catch (err) {
      setLastVoice({ text: 'I could not start listening. Please try again.', kind: 'error', at: Date.now() });
    }
  }, [recording, transcribing, send, audioRecorder]);

  // Seller-chat handoff: open ChatScreen with the AI draft pre-filled plus the
  // product card. The user presses send in the chat — nothing auto-sends here.
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
    send, confirm, cancel, reset, openSellerChat,
    startGoogleAuth, authBusy, notice, speak,
  }), [
    conversationId, messages, status, error, isReady, send, confirm, cancel, reset,
    recording, transcribing, toggleRecording, lastVoice, dismissVoice, confirmVoice, cancelVoice,
    openSellerChat,
    startGoogleAuth, authBusy, notice, speak,
  ]);

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI() {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error('useAI must be used inside <AIProvider>.');
  return ctx;
}