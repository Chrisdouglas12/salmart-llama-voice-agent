/**
 * SALMART — Native chat state
 *
 * Owns every live DM and group thread. The backend is asymmetric and this file
 * is where that asymmetry is absorbed so the screens stay dumb:
 *
 *   DM     — send is SOCKET-ONLY (`sendMessage`). No HTTP fallback exists.
 *   Group  — send works over REST *and* socket, so we use REST and still get
 *            live delivery from the `newGroupMessage` broadcast.
 *   Reads  — both are REST.
 *
 * Sends are optimistic and keyed by a client-generated tempId. The server
 * persists tempId and is idempotent on it, so a retry can never double-post.
 * The `messageStatusUpdate` ack carries only {_id, tempId, status}, so merges
 * are always by tempId and never by guessing a conversation.
 *
 * Without socket.io-client installed the DM composer reports `canSendDm:
 * false` and history still loads over REST, so the screen degrades to
 * read-only instead of crashing on a missing dependency.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState } from 'react-native';

import {
  getDmThread, getGroupThread, sendGroupMessageRest, normaliseMessage,
  uploadChatImage, postGroupListing,
} from '../api/endpoints';
import { mediaUrl, onOnlineChange } from '../api/client';
import {
  socketAvailable, connectSocket, disconnectSocket, onSocketEvent, onSocketState,
  joinChatRoom, leaveChatRoom, joinGroupRoom, leaveGroupRoom, markSeen,
  sendDm, sendTyping, sendGroupTyping, requestUserStatus, currentUserId, chatRoomId,
} from '../api/socket';
import * as chatStore from '../chat/store';
import { uiToStoreMessage, storeToUiMessage, conversationFromMessage } from '../chat/model';
import { mergeMessages, applyStatusUpdate } from '../chat/merge';
import { SEEN_STATUS, isUnreadStatus, isIncoming } from '../chat/readState';
import { flushChatOutbox, syncThread } from '../services/chatSync';

const ChatCtx = createContext(null);
export const useChat = () => useContext(ChatCtx);

/** messages.js:1374 — a typing signal older than this is stale. */
const TYPING_STALE_MS = 4000;
/** chats.js:506 — stop telling the peer we're typing after 2s of silence. */
const TYPING_STOP_MS = 2000;
/** chats.js:217-226 — never ask the server for the same user's status more often. */
const STATUS_REQUEST_THROTTLE = 5000;

let tempCounter = 0;
const makeTempId = (me) => {
  tempCounter += 1;
  return `${me || 'anon'}-${Date.now()}-${tempCounter}`;
};

/**
 * True when a fetch failed because there is no connection rather than because
 * the server rejected the request. Used to keep "opened a chat while offline"
 * from surfacing as an error the user cannot act on.
 */
function isNetworkError(err) {
  if (!err) return true;
  return err.isNetwork === true || err.offline === true || err.status === 0;
}

/** The conversation id an inbound message belongs to (partnerId or groupId). */
function chatIdForMessage(p, me) {
  if (p.groupId != null) return String(p.groupId);
  const s = String(p.senderId || '');
  const r = String(p.receiverId || '');
  return s === String(me) ? r : s;
}

/** The other participant of a DM thread key (`[a,b].sort().join('_')`). */
function partnerFromDmKey(key, me) {
  if (!key || key.startsWith('group:')) return null;
  const parts = String(key).split('_');
  if (parts.length !== 2) return null;
  return parts[0] === String(me) ? parts[1] : parts[0];
}

/**
 * Who the OTHER person in a thread is.
 *
 * Only a message the partner sent may name the conversation: our own messages
 * carry `senderInfo: { firstName: 'You' }` — or our real profile, when the
 * server echoes the row back — so reading the identity off the newest row is
 * exactly how the inbox ends up showing your own name and picture.
 */
function peerIdentity(messages, me) {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m) continue;
    if (me && String(m.senderId) === String(me)) continue;
    const s = m.senderInfo || {};
    const name = [s.firstName, s.lastName].filter(Boolean).join(' ').trim()
      || m.senderName || '';
    // "You" is the label our own messages carry — it never names the peer.
    if (!name || String(name).trim().toLowerCase() === 'you') continue;
    const picture = m.senderProfilePicture || s.profilePicture || null;
    if (name || picture) return { name, picture };
  }
  return { name: '', picture: null };
}

export function ChatProvider({ children, userId, token }) {
  const [socketState, setSocketState] = useState('idle');

  // threadKey -> message[]. Kept outside React state for the socket handlers so
  // an inbound event never depends on a render having happened first.
  const threads = useRef(new Map());
  // A monotonically-increasing counter that IS part of the context value, so a
  // message/patch (which only mutates the ref) still re-renders every consumer.
  // Without this the memoised value identity is stable and consumers such as
  // ChatScreen/MessagesScreen never see a live message or a reorder.
  const [threadsVersion, setThreadsVersion] = useState(0);
  const rerender = useCallback(() => setThreadsVersion(n => n + 1), []);

  const me = useMemo(
    () => (userId ? String(userId) : currentUserId()),
    [userId],
  );

  const patchThread = useCallback((key, updater) => {
    const cur = threads.current.get(key) || { messages: [], loading: false, error: null };
    const next = updater(cur);
    threads.current.set(key, next);
    rerender();
    return next;
  }, [rerender]);

  // ─── Typing ────────────────────────────────────────────────────────────────
  //
  // Two halves that deliberately live together so the timers can never drift:
  //
  //   emit   noteTyping(kind, id) — the web's chats.js:500-508 / group-logic
  //          .js:866-874 pattern: signal `true` when typing starts, then keep
  //          pushing out a 2s auto-stop so a dead composer goes quiet.
  //   receive typingRows keyed by partnerId (DM) or `group:<id>` — each signal
  //          arms a 4s stale timer (messages.js:1374) so a vanished socket
  //          can't leave "typing" on screen forever.

  const [typingRows, setTypingRows] = useState({});
  const typingTimers = useRef(new Map());

  // Inbox previews pushed to the personal room `user_<me>` for conversations the
  // client has NOT joined. DM previews arrive via
  // `newMessageNotification` (socketRoutes.js:607) and group previews via
  // `newGroupMessageNotification` (socketRoutes.js:1180). They let the Messages
  // list show + reorder a conversation the instant a message lands, without
  // joining a socket room per conversation. Keyed by partnerId (DM) or
  // `group:<id>` (group); each entry is a normalised preview.
  const [inboxPreviews, setInboxPreviews] = useState({});

  const setInboxPreview = useCallback((key, preview) => {
    setInboxPreviews(prev => {
      const before = prev[key];
      // Ignore stale/out-of-order arrivals; a newer arrival always replaces.
      if (before && preview.at < before.at) return prev;
      return { ...prev, [key]: preview };
    });
  }, []);

  const clearTypingFlag = useCallback(key => {
    const timer = typingTimers.current.get(key);
    if (timer) { clearTimeout(timer); typingTimers.current.delete(key); }
    setTypingRows(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const setTypingFlag = useCallback((key, on, name) => {
    const timer = typingTimers.current.get(key);
    if (timer) clearTimeout(timer);
    if (!on) {
      typingTimers.current.delete(key);
      setTypingRows(prev => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const stale = setTimeout(() => clearTypingFlag(key), TYPING_STALE_MS);
    typingTimers.current.set(key, stale);
    setTypingRows(prev => ({
      ...prev,
      [key]: { ...prev[key], ...(name ? { name } : {}) },
    }));
  }, [clearTypingFlag]);

  const typingEmit = useRef(new Map());

  const noteTyping = useCallback((kind, id) => {
    if (!socketAvailable || !id) return;
    const key = `${kind}:${id}`;
    let rec = typingEmit.current.get(key);
    if (!rec) {
      rec = { active: false, stop: null };
      typingEmit.current.set(key, rec);
    }
    if (!rec.active) {
      rec.active = true;
      if (kind === 'group') sendGroupTyping(id, true);
      else sendTyping(id, true);
    }
    if (rec.stop) clearTimeout(rec.stop);
    rec.stop = setTimeout(() => {
      rec.active = false;
      if (kind === 'group') sendGroupTyping(id, false);
      else sendTyping(id, false);
      typingEmit.current.delete(key);
    }, TYPING_STOP_MS);
  }, []);

  // A pending auto-stop must not outlive the provider.
  useEffect(() => () => {
    typingEmit.current.forEach(rec => { if (rec.stop) clearTimeout(rec.stop); });
    typingEmit.current.clear();
    typingTimers.current.forEach(t => clearTimeout(t));
    typingTimers.current.clear();
  }, []);

  // ─── Presence (online / last seen) ─────────────────────────────────────────
  //
  // Mirrors the web's userStatuses map (chats.js:1834-1844): every
  // `userStatusUpdate` / `userStatusBatch` fills a per-user {isOnline,
  // lastSeen} record, and `requestPresence` re-asks the server at most once
  // per user per 5s (chats.js:217-226). The header decides HOW to render a
  // record (typing > Online > "Last seen …"); this layer only stores truth.

  const [presence, setPresence] = useState({});
  const presenceThrottle = useRef(new Map());

  const applyPresence = useCallback(entries => {
    if (!Array.isArray(entries) || !entries.length) return;
    setPresence(prev => {
      let next = prev;
      entries.forEach(s => {
        if (!s || s.userId == null) return;
        const id = String(s.userId);
        // Keep the old lastSeen when the server omits it (e.g. an online
        // "warm" ping) — formatting needs a concrete date to say anything.
        const lastSeen = s.lastSeen
          ? String(s.lastSeen)
          : (prev[id]?.lastSeen || undefined);
        if (next === prev) next = { ...prev };
        next[id] = { isOnline: !!s.isOnline, lastSeen, name: s.name || prev[id]?.name };
      });
      return next;
    });
  }, []);

  const requestPresence = useCallback((userIds) => {
    if (!socketAvailable) return;
    const list = (Array.isArray(userIds) ? userIds : [userIds])
      .filter(Boolean).map(String);
    if (!list.length || !list.some(id => id && String(id) !== String(me || ''))) return;
    const now = Date.now();
    const fresh = list.filter(id => (
      (presenceThrottle.current.get(id) || 0) <= now - STATUS_REQUEST_THROTTLE
    ));
    if (!fresh.length) return;
    fresh.forEach(id => presenceThrottle.current.set(id, now));
    requestUserStatus(fresh);
  }, [me]);

  // ─── Connection lifecycle ────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return undefined;
    chatStore.openChatDb().catch(() => {});
    try { chatStore.claimOwner(me); } catch (_e) {}
    connectSocket(token, me);
    const offState = onSocketState(setSocketState);
    return () => { offState(); disconnectSocket(); };
  }, [token, me]);

  // ─── Thread loading ──────────────────────────────────────────────────────

  const openDm = useCallback(async (partnerId) => {
    if (!me || !partnerId) return;
    const key = chatRoomId(me, partnerId);
    joinChatRoom(partnerId);
    markSeen([partnerId]);

    // Seed from the single chat store so the UI can show history while offline.
    try {
      const stored = await chatStore.getMessages(String(partnerId), { limit: 80 });
      if (stored.length) {
        const converted = stored.map(r => storeToUiMessage(r, { me, isGroup: false }));
        patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages: converted }));
      }
    } catch (_e) {}

    patchThread(key, cur => ({ ...cur, loading: true, error: null, partnerId }));
    try {
      const rows = await getDmThread(me, partnerId, { params: { limit: 40 } });
      const messages = mergeMessages(threads.current.get(key)?.messages || [], rows);
      patchThread(key, cur => ({ ...cur, messages, loading: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(partnerId), isGroup: false }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
      markSeen([partnerId]);
    } catch (err) {
      const prev = threads.current.get(key);
      // A cold cache plus a failed fetch is the only case worth shouting about —
      // but only when the server actually answered. Offline we leave the thread
      // blank so the friendly offline welcome shows, and the reconnect listener
      // below loads it once the connection returns.
      if (!prev?.messages.length) {
        patchThread(key, cur => ({
          ...cur,
          loading: false,
          error: isNetworkError(err) ? null : (err?.message || 'Could not load messages.'),
        }));
      } else {
        patchThread(key, cur => ({ ...cur, loading: false }));
      }
    }
  }, [me, patchThread]);

  const openGroup = useCallback(async (groupId) => {
    if (!groupId) return;
    const key = `group:${groupId}`;
    joinGroupRoom(groupId);

    try {
      const stored = await chatStore.getMessages(String(groupId), { limit: 80 });
      if (stored.length) {
        const converted = stored.map(r => storeToUiMessage(r, { me, isGroup: true }));
        patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages: converted }));
      }
    } catch (_e) {}

    patchThread(key, cur => ({ ...cur, loading: true, error: null, groupId }));
    try {
      const rows = await getGroupThread(groupId, { params: { limit: 40 } });
      const messages = mergeMessages(threads.current.get(key)?.messages || [], rows);
      patchThread(key, cur => ({ ...cur, messages, loading: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(groupId), isGroup: true }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
    } catch (err) {
      const prev = threads.current.get(key);
      if (!prev?.messages.length) {
        patchThread(key, cur => ({
          ...cur,
          loading: false,
          error: isNetworkError(err) ? null : (err?.message || 'Could not load messages.'),
        }));
      } else {
        patchThread(key, cur => ({ ...cur, loading: false }));
      }
    }
  }, [me, patchThread]);

  /**
   * Warm a thread WITHOUT opening it — the WhatsApp inbox behaviour. The
   * messages panel calls this for the most recent conversations while they are
   * still on screen, so tapping a row is instant instead of paying the 40-row
   * fetch inside the chat screen's first frame.
   *
   * Deliberately reads-only: no room join (the user has not opened the chat),
   * no `markSeen` (these are not opened). It also backs off the moment the
   * thread already holds messages, so an in-flight `openDm` always wins.
   */
  const prefetchDm = useCallback(async (partnerId) => {
    if (!me || !partnerId) return;
    const key = chatRoomId(me, partnerId);
    if (threads.current.get(key)?.messages.length) return;

    try {
      const stored = await chatStore.getMessages(String(partnerId), { limit: 80 });
      if (stored.length) {
        const converted = stored.map(r => storeToUiMessage(r, { me, isGroup: false }));
        patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages: converted }));
      }
    } catch (_e) {}
    if (threads.current.get(key)?.messages.length) return;

    try {
      const rows = await getDmThread(me, partnerId, { params: { limit: 40 } });
      const messages = mergeMessages(threads.current.get(key)?.messages || [], rows);
      patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages, loading: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(partnerId), isGroup: false }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
    } catch (_e) {}
  }, [me, patchThread]);

  const prefetchGroup = useCallback(async (groupId) => {
    if (!groupId) return;
    const key = `group:${groupId}`;
    if (threads.current.get(key)?.messages.length) return;

    try {
      const stored = await chatStore.getMessages(String(groupId), { limit: 80 });
      if (stored.length) {
        const converted = stored.map(r => storeToUiMessage(r, { me, isGroup: true }));
        patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages: converted }));
      }
    } catch (_e) {}
    if (threads.current.get(key)?.messages.length) return;

    try {
      const rows = await getGroupThread(groupId, { params: { limit: 40 } });
      const messages = mergeMessages(threads.current.get(key)?.messages || [], rows);
      patchThread(key, cur => (cur.messages.length ? cur : { ...cur, messages, loading: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(groupId), isGroup: true }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
    } catch (_e) {}
  }, [me, patchThread]);

  // ─── Inbound events ──────────────────────────────────────────────────────
  // Declared after openGroup/setTypingFlag because the deps array reads them.

  /**
   * Persist a message that arrived over the socket so it survives a restart and
   * is available offline even if the thread was NEVER opened. Writes to both the
   * thread store (sm_local.db, read by openDm) and the inbox store (salmart.db,
   * read by the Messages panel) so a received message updates both surfaces.
   */
  const persistInbound = useCallback((row, isGroup) => {
    if (!row || !row.key) return;
    const chatId = isGroup ? row.groupId : String(chatIdForMessage(row, me));
    if (!chatId) return;
    const storeRow = uiToStoreMessage(row, { me, conversationId: chatId, isGroup, pending: false });
    if (!storeRow) return;
    chatStore.upsertServerMessages([storeRow]).catch(() => {});
    const conv = conversationFromMessage(row, { me, conversationId: chatId, isGroup });
    if (conv) chatStore.upsertConversations([conv]).catch(() => {});
  }, [me]);

  /**
   * Persist a message WE sent so an offline (queued) send survives a restart and
   * still shows in the thread and at the top of the inbox. Only queued DMs call
   * this — an online send already comes back as a real server row, and writing a
   * tempId twin for it would duplicate history.
   */
  const persistOutbound = useCallback((row, conversationId, isGroup) => {
    if (!row || !row.key || conversationId == null) return;
    const storeRow = uiToStoreMessage(row, {
      me, conversationId: String(conversationId), isGroup: !!isGroup, pending: true,
    });
    if (!storeRow) return;
    chatStore.insertOutgoingMessage(storeRow).catch(() => {});
    // Name/avatar are omitted on purpose: the store's COALESCE upsert preserves
    // the ones already known from a prior sync instead of blanking them.
    const conv = conversationFromMessage(
      { ...row, senderId: me },
      { me, conversationId: String(conversationId), isGroup: !!isGroup },
    );
    if (conv) chatStore.upsertConversations([conv]).catch(() => {});
  }, [me]);

  useEffect(() => {
    if (!socketAvailable) return undefined;

    const off = onSocketEvent((event, payload) => {
      const p = payload || {};

      if (event === 'newMessage' && p.senderId && p.receiverId) {
        const key = chatRoomId(p.senderId, p.receiverId);
        const row = normaliseMessage(p);
        patchThread(key, cur => ({
          ...cur,
          messages: mergeMessages(cur.messages, [row]),
        }));
        persistInbound(row, false);
        return;
      }

      if (event === 'messageStatusUpdate' && (p.tempId || p._id)) {
        // The ack is thread-agnostic, so try every open thread. There are only
        // ever one or two on screen, so this stays cheap. The ack may also
        // arrive without a tempId (a server that does not echo our client id),
        // in which case the row is matched on its server id or its timestamp.
        Array.from(threads.current.keys()).forEach(key => {
          const cur = threads.current.get(key);
          const before = cur.messages;
          const after = applyStatusUpdate(before, p);
          if (after === before) return;
          patchThread(key, c => ({ ...c, messages: after }));
          // Once the server confirms the message with a real _id, store the
          // real row and retire the optimistic copy so offline history stays
          // clean and our own sent messages are readable without a network.
          if (p._id) {
            const confirmed = after.find(m => m._id === p._id)
              || (p.tempId ? after.find(m => m.tempId === p.tempId) : null);
            if (confirmed) persistInbound(confirmed, false);
          }
        });
        return;
      }

      if (event === 'messageError' && p.tempId) {
        Array.from(threads.current.keys()).forEach(key => {
          const cur = threads.current.get(key);
          if (!cur.messages.some(m => m.tempId === p.tempId)) return;
          patchThread(key, c => ({
            ...c,
            messages: c.messages.map(m => (
              m.tempId === p.tempId ? { ...m, status: 'failed', error: p.error } : m
            )),
          }));
        });
        return;
      }

      if (event === 'messagesMarkedAsSeen' && p.senderId && me) {
        const key = chatRoomId(me, p.senderId);
        patchThread(key, cur => ({
          ...cur,
          messages: cur.messages.map(m => (
            m.senderId === me && isUnreadStatus(m.status) ? { ...m, status: SEEN_STATUS } : m
          )),
        }));
        try { chatStore.markThreadRead(key, me); } catch (_e) {}
        return;
      }

      if (event === 'messageEdited' && p.messageId) {
        Array.from(threads.current.keys()).forEach(key => {
          const cur = threads.current.get(key);
          if (!cur.messages.some(m => m._id === p.messageId)) return;
          patchThread(key, c => ({
            ...c,
            messages: c.messages.map(m => (
              m._id === p.messageId
                ? { ...m, text: p.text, isEdited: true, editedAt: p.editedAt }
                : m
            )),
          }));
        });
        return;
      }

      if (event === 'messageDeletedForMe' && p.messageId) {
        Array.from(threads.current.keys()).forEach(key => {
          const cur = threads.current.get(key);
          if (!cur.messages.some(m => m._id === p.messageId || m.key === p.messageId)) return;
          patchThread(key, c => ({
            ...c,
            messages: c.messages.filter(m => m._id !== p.messageId && m.key !== p.messageId),
          }));
        });
        try { chatStore.markDeleted(p.messageId); } catch (_e) {}
        return;
      }

      if (event === 'newGroupMessage' && p.groupId) {
        const key = `group:${p.groupId}`;
        const row = normaliseMessage(p);
        patchThread(key, cur => ({
          ...cur,
          messages: mergeMessages(cur.messages, [row]),
        }));
        persistInbound(row, true);
        return;
      }

      // Personal-room inbox previews for conversations we are not in a room for.
      // DM (socketRoutes.js:607).
      if (event === 'newMessageNotification' && p.senderId) {
        const partner = String(p.senderId);
        if (partner === String(me || '')) return;
        const at = new Date(p.createdAt || Date.now()).getTime();
        setInboxPreview(partner, {
          kind: 'dm',
          id: partner,
          senderId: partner,
          senderName: p.senderName || '',
          senderProfilePicture: p.senderProfilePicture || null,
          text: p.text || '',
          messageType: p.messageType || 'text',
          messageId: p.messageId ? String(p.messageId) : null,
          createdAt: p.createdAt || new Date(at).toISOString(),
          at,
        });
        // Also persist it: a chat we are NOT in a room for is exactly the one
        // that must still show its newest message when the app is opened offline.
        // Shares the real _id, so the later `newMessage` echo replaces this row
        // instead of duplicating it.
        const notifId = p.messageId || p._id || null;
        persistInbound(normaliseMessage({
          _id: notifId,
          tempId: notifId ? null : `notif-${partner}-${at}`,
          senderId: partner,
          receiverId: me,
          text: p.text || '',
          messageType: p.messageType || 'text',
          status: 'delivered',
          createdAt: new Date(at).toISOString(),
          senderInfo: {
            _id: partner,
            firstName: p.senderName || '',
            profilePicture: p.senderProfilePicture || null,
          },
        }), false);
        // Only the newest message arrived in this notification. Pull the rest of
        // the thread now (while we are online) so the full recent history is on
        // the device even if the user never opens this chat online.
        syncThread({ userId: me, partnerId: partner }).catch(() => {});
        return;
      }

      // Group preview (socketRoutes.js:1180). The notification omits createdAt,
      // so arrival time stands in for ordering.
      if (event === 'newGroupMessageNotification' && p.groupId) {
        if (p.senderId && String(p.senderId) === String(me || '')) return;
        const id = String(p.groupId);
        const at = Date.now();
        setInboxPreview(`group:${id}`, {
          kind: 'group',
          id,
          groupName: p.groupName || '',
          senderId: p.senderId != null ? String(p.senderId) : null,
          senderName: p.senderName || '',
          senderProfilePicture: p.senderProfilePicture || null,
          text: p.text || '',
          messageType: p.messageType || 'text',
          messageId: p.messageId ? String(p.messageId) : null,
          createdAt: new Date(at).toISOString(),
          at,
        });
        // Persist for the same reason as the DM case above: opening the group
        // offline should already contain this message.
        const groupNotifId = p.messageId || p._id || null;
        const groupSenderId = p.senderId != null ? String(p.senderId) : null;
        persistInbound(normaliseMessage({
          _id: groupNotifId,
          tempId: groupNotifId ? null : `notif-group-${id}-${at}`,
          senderId: groupSenderId,
          groupId: id,
          text: p.text || '',
          messageType: p.messageType || 'text',
          status: 'delivered',
          createdAt: new Date(at).toISOString(),
          senderInfo: {
            _id: groupSenderId,
            firstName: p.senderName || '',
            profilePicture: p.senderProfilePicture || null,
          },
        }), true);
        // Same as the DM case: backfill the whole group thread while online so
        // an unopened group is readable offline later.
        syncThread({ userId: me, groupId: id }).catch(() => {});
        return;
      }

      // Live typing (messages.js:1380-1397, group-logic.js:1579-1590).
      if (event === 'userTyping' && p.senderId) {
        if (String(p.senderId) === String(me || '')) return;
        setTypingFlag(String(p.senderId), p.isTyping !== false);
        return;
      }

      if (event === 'groupUserTyping' && p.groupId) {
        if (p.userId && String(p.userId) === String(me || '')) return;
        setTypingFlag(`group:${p.groupId}`, p.isTyping !== false, p.senderName);
        return;
      }

      // Live presence (chats.js:1834-1844). applyPresence is passed the raw
      // statuses; rendering rules live in the header, not here.
      if (event === 'userStatusUpdate' && p.userId != null) {
        applyPresence([p]);
        return;
      }

      if (event === 'userStatusBatch' && Array.isArray(p.statuses)) {
        applyPresence(p.statuses);
        return;
      }

      // Group lifecycle (group-logic.js:1597-1615): an error parked on the
      // thread is what the screen renders as its ErrorState.
      if (event === 'groupDissolved' && p.groupId) {
        patchThread(`group:${p.groupId}`, cur => ({
          ...cur, error: 'This group has been dissolved by an admin.',
        }));
        return;
      }

      if (event === 'removedFromGroup' && p.groupId) {
        patchThread(`group:${p.groupId}`, cur => ({
          ...cur, error: 'You have been removed from this group.',
        }));
        return;
      }

      if (event === 'messageDeletedForEveryone' && p.messageId) {
        Array.from(threads.current.keys()).forEach(key => {
          const cur = threads.current.get(key);
          if (!cur.messages.some(m => m._id === p.messageId || m.key === p.messageId)) return;
          patchThread(key, c => ({
            ...c,
            messages: c.messages.filter(m => m._id !== p.messageId && m.key !== p.messageId),
          }));
        });
        try { chatStore.markDeleted(p.messageId); } catch (_e) {}
        return;
      }

      if (event === 'groupInfoUpdated' && p.groupId) {
        openGroup(String(p.groupId));
      }
    });

    return off;
  }, [me, patchThread, setTypingFlag, applyPresence, openGroup, persistInbound, setInboxPreview]);

  /** Page backwards with the `before` cursor at the oldest loaded row. */
  const loadOlderDm = useCallback(async (partnerId) => {
    const key = chatRoomId(me, partnerId);
    const cur = threads.current.get(key);
    const oldest = cur?.messages?.[0];
    if (!oldest?.createdAt || cur?.loadingOlder) return null;
    patchThread(key, c => ({ ...c, loadingOlder: true }));
    try {
      const rows = await getDmThread(me, partnerId, {
        params: { before: oldest.createdAt, limit: 40 },
      });
      const messages = mergeMessages(rows, cur.messages);
      patchThread(key, c => ({ ...c, messages, loadingOlder: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(partnerId), isGroup: false }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
      return rows.length;
    } catch {
      patchThread(key, c => ({ ...c, loadingOlder: false }));
      return 0;
    }
  }, [me, patchThread]);

  const loadOlderGroup = useCallback(async (groupId) => {
    const key = `group:${groupId}`;
    const cur = threads.current.get(key);
    const oldest = cur?.messages?.[0];
    if (!oldest?.createdAt || cur?.loadingOlder) return null;
    patchThread(key, c => ({ ...c, loadingOlder: true }));
    try {
      const rows = await getGroupThread(groupId, {
        params: { before: oldest.createdAt, limit: 40 },
      });
      const messages = mergeMessages(rows, cur.messages);
      patchThread(key, c => ({ ...c, messages, loadingOlder: false }));
      const shaped = rows
        .map(m => uiToStoreMessage(m, { me, conversationId: String(groupId), isGroup: true }))
        .filter(Boolean);
      if (shaped.length) chatStore.upsertServerMessages(shaped).catch(() => {});
      return rows.length;
    } catch {
      patchThread(key, c => ({ ...c, loadingOlder: false }));
      return 0;
    }
  }, [patchThread]);

  // ─── Sending ─────────────────────────────────────────────────────────────

  /**
   * Optimistically append, then try the socket. A DM has no HTTP fallback, so
   * if the socket is down the row is marked failed rather than queued — the
   * server would reject an HTTP send that does not exist, and silently holding
   * it would lie to the user.
   */
  const sendDmText = useCallback(async (partnerId, text, extra = {}) => {
    const body = (text || '').trim();
    // An image-only send has no caption — web allows it (chats.js:1637), so an
    // attachment alone is enough of a message.
    if (!me || (!body && !extra.attachment)) return null;
    const key = chatRoomId(me, partnerId);
    const tempId = makeTempId(me);
    const optimistic = normaliseMessage({
      _id: null,
      tempId,
      senderId: me,
      receiverId: partnerId,
      text: body,
      messageType: 'text',
      status: 'sending',
      createdAt: new Date().toISOString(),
      senderInfo: { _id: me, firstName: 'You' },
      ...extra,
    });
    patchThread(key, cur => ({ ...cur, messages: mergeMessages(cur.messages, [optimistic]) }));

    const delivered = sendDm({
      tempId,
      receiverId: partnerId,
      text: body,
      messageType: extra.messageType || 'text',
      ...(extra.attachment ? { attachment: extra.attachment } : {}),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      ...(extra.replyPreviewText ? { replyPreviewText: extra.replyPreviewText } : {}),
      ...(extra.replySenderName ? { replySenderName: extra.replySenderName } : {}),
      ...(extra.offerDetails ? { offerDetails: extra.offerDetails } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
      ...(extra.viewOnce ? { viewOnce: extra.viewOnce } : {}),
    });

    if (!delivered) {
      try {
        const queuedRow = threads.current.get(key)?.messages.find(m => m.tempId === tempId) || optimistic;
        persistOutbound(queuedRow, String(partnerId), false);
        patchThread(key, cur => ({
          ...cur,
          messages: cur.messages.map(m => (
            m.tempId === tempId
              ? { ...m, status: 'queued', attempts: 0 }
              : m
          )),
        }));
      } catch (_e) {
        patchThread(key, cur => ({
          ...cur,
          messages: cur.messages.map(m => (
            m.tempId === tempId
              ? { ...m, status: 'failed', error: 'Offline — message not sent' }
              : m
          )),
        }));
      }
    }
    return { tempId, sent: delivered };
  }, [me, patchThread, persistOutbound]);

  /**
   * DM photo (chats.js:1663-1707). The optimistic row lands first with the
   * LOCAL uri so the bubble appears instantly, then the file goes up to
   * /upload-image and the row is repointed at the server URL BEFORE the socket
   * emit — a local file path must never leave the device. An upload failure
   * removes the row entirely, which is what the web does with
   * removeOptimisticMessage; a socket failure after a good upload marks it
   * failed, and retryDm can then re-emit because the URL is already real.
   */
  const sendDmImage = useCallback(async (partnerId, media, caption, extra = {}) => {
    if (!me || !partnerId || !media?.uri) return null;
    const key = chatRoomId(me, partnerId);
    const tempId = makeTempId(me);
    const text = (caption || '').trim();
    const optimistic = normaliseMessage({
      _id: null,
      tempId,
      senderId: me,
      receiverId: partnerId,
      text,
      messageType: 'image',
      attachment: { url: media.uri, type: 'image' },
      viewOnce: { enabled: false, viewed: false },
      status: 'sending',
      createdAt: new Date().toISOString(),
      senderInfo: { _id: me, firstName: 'You' },
      // Kept so a queued (still-local) image can be uploaded on a later retry.
      fileName: media.fileName || null,
      mimeType: media.mimeType || null,
      ...extra,
    });
    patchThread(key, cur => ({ ...cur, messages: mergeMessages(cur.messages, [optimistic]) }));

    // Try uploading immediately. If upload or send fails due to offline
    // conditions, persist a queued outbox item and keep the optimistic row.
    try {
      const up = await uploadChatImage(media, {
        senderId: me,
        receiverId: partnerId,
        tempId,
        messageType: 'image',
        content: text,
        viewOnce: JSON.stringify({ enabled: false, viewed: false }),
      });
      if (!up?.imageUrl) throw new Error('Image upload failed');

      // Replace local attachment with server URL
      patchThread(key, cur => ({
        ...cur,
        messages: cur.messages.map(m => (
          m.tempId === tempId
            ? {
                ...m,
                attachment: {
                  ...m.attachment,
                  url: mediaUrl(up.imageUrl),
                  cloudinaryPublicId: up.publicId || null,
                },
              }
            : m
        )),
      }));

      const delivered = sendDm({
        tempId,
        receiverId: partnerId,
        text,
        messageType: 'image',
        attachment: { url: up.imageUrl, type: 'image', cloudinaryPublicId: up.publicId || null },
        viewOnce: { enabled: false, viewed: false },
        ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
        ...(extra.replyPreviewText ? { replyPreviewText: extra.replyPreviewText } : {}),
        ...(extra.replySenderName ? { replySenderName: extra.replySenderName } : {}),
      });

      if (!delivered) {
        // Socket down: queue the send (server URL is available)
        try {
        const queuedRow = threads.current.get(key)?.messages.find(m => m.tempId === tempId);
        if (queuedRow) persistOutbound(queuedRow, String(partnerId), false);
        patchThread(key, cur => ({
          ...cur,
          messages: cur.messages.map(m => (
            m.tempId === tempId ? { ...m, status: 'queued' } : m
          )),
        }));
        } catch (_e) {
          patchThread(key, cur => ({
            ...cur,
            messages: cur.messages.map(m => (
              m.tempId === tempId ? { ...m, status: 'failed', error: 'Offline — message not sent' } : m
            )),
          }));
        }
        return { tempId, sent: false };
      }
      return { tempId, sent: true };
    } catch (err) {
      // Upload failed (probably offline). Queue the local URI so upload can
      // resume when back online.
      try {
        const queuedRow = threads.current.get(key)?.messages.find(m => m.tempId === tempId);
        if (queuedRow) persistOutbound(queuedRow, String(partnerId), false);
        patchThread(key, cur => ({
          ...cur,
          messages: cur.messages.map(m => (
            m.tempId === tempId ? { ...m, status: 'queued', attempts: 0 } : m
          )),
        }));
        return { tempId, sent: false, queued: true };
      } catch (_e) {}

      // Fallback: remove optimistic bubble on hard failure
      patchThread(key, cur => ({
        ...cur,
        messages: cur.messages.filter(m => m.tempId !== tempId),
      }));
      return { tempId, sent: false, error: err?.message || 'Image upload failed' };
    }
  }, [me, patchThread, persistOutbound]);

  const retryDm = useCallback((partnerId, tempId) => {
    const key = chatRoomId(me, partnerId);
    const row = threads.current.get(key)?.messages?.find(m => m.tempId === tempId);
    if (!row) return;
    patchThread(key, cur => ({
      ...cur,
      messages: cur.messages.map(m => (
        m.tempId === tempId ? { ...m, status: 'sending', error: null } : m
      )),
    }));
    // tempId is unchanged, so the server's idempotency check makes this safe.
    sendDm({
      tempId,
      receiverId: partnerId,
      text: row.text,
      messageType: row.messageType || 'text',
      ...(row.attachment ? { attachment: row.attachment } : {}),
      ...(row.metadata ? { metadata: row.metadata } : {}),
    });
  }, [me, patchThread]);

  /**
   * Groups send over REST, so this works with or without a socket. tempId is
   * still passed so the live `newGroupMessage` echo de-duplicates against the
   * optimistic row.
   */
  const sendGroupText = useCallback(async (groupId, text, extra = {}) => {
    const body = (text || '').trim();
    if (!body) return null;
    const key = `group:${groupId}`;
    const tempId = makeTempId(me);
    const optimistic = normaliseMessage({
      _id: null,
      tempId,
      senderId: me,
      groupId,
      text: body,
      messageType: extra.messageType || 'text',
      status: 'sending',
      createdAt: new Date().toISOString(),
      senderInfo: { _id: me, firstName: 'You' },
      ...extra,
    });
    patchThread(key, cur => ({ ...cur, messages: mergeMessages(cur.messages, [optimistic]) }));

    try {
      const saved = await sendGroupMessageRest(groupId, {
        tempId,
        text: body,
        messageType: extra.messageType || 'text',
        ...(extra.attachment ? { attachment: extra.attachment } : {}),
      });
      // The route answers { success, data: <payload> } (groupRoutes.js:947);
      // unwrap it so the merged row carries the real _id immediately. The
      // tempId dedupe in mergeMessages collapses it with the optimistic twin.
      const confirmed = normaliseMessage({ ...(saved?.data || saved), tempId });
      patchThread(key, cur => ({
        ...cur,
        messages: mergeMessages(cur.messages, [confirmed]),
      }));
      persistInbound(confirmed, true);
      return { tempId, sent: true };
    } catch (err) {
      patchThread(key, cur => ({
        ...cur,
        messages: cur.messages.map(m => (
          m.tempId === tempId
            ? { ...m, status: 'failed', error: err.message }
            : m
        )),
      }));
      return { tempId, sent: false };
    }
  }, [me, patchThread]);

  /**
   * Group "Post a Product" (group-logic.js:993-1058): optimistic bubble with
   * the LOCAL image first, then the multipart POST. The route answers with the
   * real message (listingPostId included) AND broadcasts it, so the tempId
   * dedupe collapses all of it into one row. A failed upload drops the row —
   * web behaviour (group-logic.js:1054-1056).
   */
  const sendGroupListing = useCallback(async (groupId, image, fields) => {
    if (!groupId || !image?.uri) return null;
    const key = `group:${groupId}`;
    const tempId = makeTempId(me);
    const optimistic = normaliseMessage({
      _id: null,
      tempId,
      senderId: me,
      groupId,
      messageType: 'group-listing',
      listing: {
        title: fields.title,
        price: fields.price,
        quantity: fields.quantity,
        description: fields.description,
        condition: fields.condition,
        location: fields.location,
        imageUrl: image.uri,
        listingPostId: null,
        sellerId: me,
      },
      status: 'sending',
      createdAt: new Date().toISOString(),
      senderInfo: { _id: me, firstName: 'You' },
    });
    patchThread(key, cur => ({ ...cur, messages: mergeMessages(cur.messages, [optimistic]) }));

    try {
      const d = await postGroupListing(groupId, image, { tempId, ...fields });
      const saved = d?.data || d;
      const confirmed = normaliseMessage({ ...saved, tempId });
      patchThread(key, cur => ({
        ...cur,
        messages: mergeMessages(cur.messages, [confirmed]),
      }));
      persistInbound(confirmed, true);
      return { tempId, sent: true };
    } catch (err) {
      patchThread(key, cur => ({
        ...cur,
        messages: cur.messages.filter(m => m.tempId !== tempId),
      }));
      return { tempId, sent: false, error: err?.message || 'Failed to post listing. Please try again.' };
    }
  }, [me, patchThread]);

  // Drain the SQLite outbox when we reconnect.
  const drainOutbox = useCallback(async () => {
    if (!socketAvailable) return;
    try {
      await flushChatOutbox();
    } catch (_e) {}
  }, []);

  useEffect(() => {
    if (socketState === 'connected') drainOutbox();
  }, [socketState, drainOutbox]);

  const retryQueued = useCallback(async (tempId) => {
    try {
      const pending = await chatStore.getPendingMessages(200);
      const hit = pending.find(m => (m.clientId || m.id) === tempId || m.id === tempId);
      if (hit) await chatStore.patchMessage(hit.id, { nextAttempt: 0 });
    } catch (_e) {}
    drainOutbox();
  }, [drainOutbox]);

  const cancelQueued = useCallback(async (tempId) => {
    try {
      const pending = await chatStore.getPendingMessages(200);
      const hit = pending.find(m => (m.clientId || m.id) === tempId || m.id === tempId);
      if (hit) await chatStore.markDeleted(hit.id);
    } catch (_e) {}
    // mark optimistic row as failed/cancelled
    Array.from(threads.current.keys()).forEach(tk => {
      patchThread(tk, cur => ({
        ...cur,
        messages: cur.messages.map(m => (
          m.tempId === tempId ? { ...m, status: 'failed', error: 'Cancelled' } : m
        )),
      }));
    });
  }, []);

  const markThreadSeen = useCallback((partnerId) => {
    markSeen([partnerId]);
    if (!me || !partnerId) return;
    const key = chatRoomId(me, partnerId);
    const cur = threads.current.get(key);
    if (cur && cur.messages) {
      const hasUnread = cur.messages.some(m => isIncoming(m, me) && isUnreadStatus(m.status));
      if (!hasUnread) return;
      patchThread(key, c => ({
        ...c,
        messages: c.messages.map(m => (
          isIncoming(m, me) && isUnreadStatus(m.status) ? { ...m, status: SEEN_STATUS } : m
        )),
      }));
      try {
        chatStore.markThreadRead(key, me);
        // Persist the updated rows so the offline inbox reflects them after restart.
        const updated = threads.current.get(key)?.messages || [];
        updated.forEach(m => {
          if (isIncoming(m, me) && m.status === SEEN_STATUS) persistInbound(m, false);
        });
      } catch (_e) {}
    } else {
      try { chatStore.markThreadRead(key, me); } catch (_e) {}
    }
  }, [me, patchThread]);

  const watchedRef = useRef({ chats: new Set(), groups: new Set() });

  const closeThread = useCallback(({ partnerId, groupId } = {}) => {
    if (partnerId && !watchedRef.current.chats.has(String(partnerId))) leaveChatRoom(partnerId);
    if (groupId && !watchedRef.current.groups.has(String(groupId))) leaveGroupRoom(groupId);
  }, []);

  /**
   * Keep the socket in the rooms for the conversations currently listed on the
   * Messages panel. That is what lets a "typing…" indicator and a live
   * last-message/reorder reach the LIST even though the user is not inside the
   * chat. Bounded to what the panel passes in (top rows only).
   */
  const watchInbox = useCallback(({ chats = [], groups = [] } = {}) => {
    const w = watchedRef.current;
    w.chats = new Set((chats || []).filter(Boolean).map(String));
    w.groups = new Set((groups || []).filter(Boolean).map(String));
    w.chats.forEach(id => joinChatRoom(id));
    w.groups.forEach(id => joinGroupRoom(id));
  }, []);

  /** Re-fetch every thread that is currently mounted (used on resume/reconnect). */
  const reloadOpenThreads = useCallback(() => {
    Array.from(threads.current.entries()).forEach(([key, cur]) => {
      if (cur.groupId) openGroup(cur.groupId);
      else if (cur.partnerId) openDm(cur.partnerId);
    });
  }, [openDm, openGroup]);

  // Re-read the thread when the app returns to the foreground: a socket can
  // stay nominally "connected" while the OS has frozen the JS timers.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      reloadOpenThreads();
    });
    return () => sub.remove();
  }, [reloadOpenThreads]);

  // Connectivity restored while the app stays open: retry any thread that was
  // left blank because it was first opened offline.
  useEffect(() => onOnlineChange(online => { if (online) reloadOpenThreads(); }),
    [reloadOpenThreads]);

  const getThread = useCallback(key => threads.current.get(key) || {
    messages: [], loading: false, loadingOlder: false, error: null,
  }, []);

  /**
   * A flat summary of every live thread, recomputed whenever a thread changes.
   * The Messages panel uses this to surface a conversation that arrived live but
   * is not yet in the fetched inbox (e.g. a brand-new inbound DM), and to keep
   * the newest message on top without waiting for a refetch.
   */
  const liveThreads = useMemo(() => {
    const out = [];
    threads.current.forEach((cur, key) => {
      const msgs = cur.messages;
      const last = msgs && msgs.length ? msgs[msgs.length - 1] : null;
      if (!last) return;
      const partnerId = cur.partnerId || partnerFromDmKey(key, me);
      // The peer's identity comes from a message THEY sent, never from our own
      // last message — that one says "You" and would rename the conversation.
      const peer = peerIdentity(msgs, me);
      out.push({
        key,
        partnerId: partnerId ? String(partnerId) : null,
        groupId: cur.groupId ? String(cur.groupId) : null,
        last,
        peerName: peer.name,
        peerAvatar: peer.picture,
      });
    });
    return out;
  }, [me, threadsVersion]);

  const value = useMemo(() => ({
    me,
    socketState,
    canSendDm: socketAvailable,
    getThread,
    openDm,
    openGroup,
    prefetchDm,
    prefetchGroup,
    loadOlderDm,
    loadOlderGroup,
    sendDmText,
    sendDmImage,
    sendGroupText,
    sendGroupListing,
    retryDm,
    retryQueued,
    cancelQueued,
    markThreadSeen,
    closeThread,
    watchInbox,
    typingRows,
    inboxPreviews,
    noteTyping,
    presence,
    requestPresence,
    threadsVersion,
    liveThreads,
  }), [
    me, socketState, getThread, openDm, openGroup, prefetchDm, prefetchGroup,
    loadOlderDm, loadOlderGroup, sendDmText, sendDmImage, sendGroupText, sendGroupListing, retryDm,
    retryQueued, cancelQueued, markThreadSeen, closeThread, watchInbox, typingRows, inboxPreviews, noteTyping,
    presence, requestPresence, threadsVersion, liveThreads,
  ]);

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}

export { mergeMessages };