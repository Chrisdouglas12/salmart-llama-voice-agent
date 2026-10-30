/**
 * SALMART — Direct message thread (native)
 *
 * Replaces the WebView /chat/:id route.
 *
 * All state lives in ChatContext; this screen is the view layer plus a composer.
 * The one non-obvious bit is the inverted FlatList: chat is anchored to the
 * BOTTOM, so `inverted` is used and the data array is reversed on the way in.
 * That gives free "stick to newest" behaviour and avoids the scroll-jump that
 * an onContentSizeChange approach produces when a burst of messages arrives.
 *
 * Keyboard: Android edge-to-edge (Expo SDK 53) and iOS do not resize the window
 * for the IME, while some Android setups still do. Rather than guess, we use
 * `useKeyboardOverlap`: it compares the keyboard's top edge with where this
 * screen's container actually ends and reserves only the overlap. If the window
 * already resized the overlap is 0; otherwise it is the exact covered height.
 * No KeyboardAvoidingView, no double-padding, no gap above the keyboard.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, FlatList, Pressable, StyleSheet, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';

import { shadow, createThemed, useTheme } from '../theme/theme';
import { useNav, useNavActions } from '../state/Navigation';
import { useChat } from '../state/ChatContext';
import { useAuth } from '../state/AuthContext';
import {
  Avatar, Row, Tiny, Small, T2, EmptyState, ErrorState,
  Sheet, Button, Input, Toast,
} from '../ui/kit';
import { MessageBubble, ChatComposer, DateDivider, TypingDots, PresenceStatus } from '../ui/chat';
import { MediaViewer } from '../ui/MediaViewer';
import { scanContent } from '../ui/contentFilter';
import { useKeyboardOverlap } from '../ui/useKeyboardHeight';
import {
  reportChatUser, blockChatUser, unblockChatUser, getBlockedStatus, getPublicUser,
  downloadDigital as fetchDownloadLink,
} from '../api/endpoints';
import { absUrl } from '../api/client';
import { notifyBlock } from '../api/socket';
import { saveDigitalDownload } from '../utils/download';

/**
 * Present a name safely.
 *
 * Route params can arrive percent-encoded or carry stray control characters,
 * and a raw value here is what produced the odd-looking greeting. Decode,
 * strip control chars, and fall back to a plain-English default.
 */
function safeName(raw) {
  let n = String(raw || '').trim();
  if (!n) return 'this member';
  try { n = decodeURIComponent(n); } catch (_e) { /* not percent-encoded */ }
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return n || 'this member';
}

/**
 * Placeholders that callers pass when they only had an id (`'Seller'`, `'User'`)
 * are not real names: treat them as missing so the header resolves the actual
 * peer instead of displaying the placeholder. `'You'` is in the list because
 * that is the label the chat puts on OUR OWN messages — a route that carries
 * it is pointing at our own identity by mistake.
 */
const GENERIC_NAMES = new Set(['chat', 'user', 'seller', 'member', 'this member', 'guest', 'you']);
function hasRealName(raw) {
  const n = String(raw || '').trim().toLowerCase();
  return !!n && !GENERIC_NAMES.has(n);
}

/** True when a name is the chat's label for our own messages. */
function isSelfLabel(raw) {
  return String(raw || '').trim().toLowerCase() === 'you';
}

/** Insert a date divider whenever the calendar day changes. */
function withDividers(messages) {
  const out = [];
  let lastDay = null;
  messages.forEach(m => {
    const day = m.createdAt ? new Date(m.createdAt).toDateString() : null;
    if (day && day !== lastDay) {
      out.push({ kind: 'divider', key: `d-${day}-${m.key}`, at: m.createdAt });
      lastDay = day;
    }
    out.push({ kind: 'message', ...m });
  });
  return out;
}

/** Who wrote the message being replied to (chats.js:1653-1656). */
function replySenderName(m) {
  const s = m?.senderInfo || {};
  return [s.firstName, s.lastName].filter(Boolean).join(' ') || m?.senderName || 'Member';
}

/** Reply preview text — media messages fall back to a placeholder. */
function replyPreview(m) {
  const text = (m?.text || '').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  if (m?.messageType === 'image' || m?.attachment) return 'Photo';
  if (m?.messageType === 'group-listing') return 'Listing';
  return 'Message';
}

export default function ChatScreen({ route, embedded = false, onBack }) {
  const { T } = useTheme();
  const styles = useStyles();
  const params = route?.params || {};
  const partnerId = String(params.partnerId || params.userId || params.id || '');
  const routePartnerName = params.name || params.partnerName || params.displayName || '';
  const routePartnerPicture = params.picture || params.profilePicture || params.chatPartnerProfilePicture || params.partnerProfilePicture || '';

  const nav = useNav();
  // Actions-only bag: its identity is stable, so the bubble's link handler
  // can sit in renderItem's deps without re-rendering the list on every
  // navigation-state change (what useNav()'s merged object would do).
  const navActions = useNavActions();
  const openSalmartLink = useCallback(
    url => navActions.go(url),
    [navActions],
  );
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const drawerWidth = Math.min(340, Math.round(winWidth * 0.86));
  const listRef = useRef(null);

  // The photo viewer's poster chip for my own photos: chat's senderInfo only
  // ever says "You" for outgoing messages, so AuthContext is the real source.
  const { firstName, lastName } = useAuth();

  // Container that holds the list + composer. Its bottom edge is compared with
  // the keyboard's top edge to get the real overlap.
  const boxRef = useRef(null);
  const { overlap, keyboardOpen, onLayout: onBoxLayout } = useKeyboardOverlap(boxRef);

  /**
   * Back means "leave the conversation", not "pop the stack".
   *
   * When rendered inside the messages panel's split view this screen was never
   * pushed, so `nav.goBack()` would leave the panel entirely — the caller passes
   * `onBack` to close the thread instead. Standalone, it pops as usual.
   */
  const back = onBack || (() => nav.goBack());

  const {
    me, socketState, canSendDm, getThread, openDm, loadOlderDm,
    sendDmText, sendDmImage, retryDm, markThreadSeen, closeThread,
    typingRows, noteTyping, presence, requestPresence,
  } = useChat();

  const [text, setText] = useState('');
  // AI handoff: draft message + product card, pre-filled but never auto-sent.
  const aiDraft = typeof params.draft === 'string' ? params.draft.slice(0, 500) : '';
  const aiProduct = params.product && typeof params.product === 'object' ? params.product : null;
  const [aiProductCard, setAiProductCard] = useState(aiProduct);
  useEffect(() => {
    if (aiDraft) setText(aiDraft);
    if (aiProduct) setAiProductCard(aiProduct);
    // Apply once per navigation — the composer belongs to the user after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);
  const [pendingImage, setPendingImage] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const thread = getThread(chatKey(me, partnerId));
  const { messages, loading, error } = thread;

  // Route params are the fastest source for the peer's identity, but not every
  // caller has it: a profile's Message button, an alert tap or a deep link can
  // hand over a bare partnerId. Resolve the rest from the thread we already
  // loaded (the peer's senderInfo on any inbound message), then live presence,
  // and finally a one-off public-user lookup — so the header never gets stuck
  // on a placeholder like "Chat" or "User".
  const peerInfo = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && String(m.senderId) === partnerId) {
        const s = m.senderInfo || {};
        const n = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
        if (n || s.profilePicture) return { name: n, picture: s.profilePicture || null };
      }
    }
    return null;
  }, [messages, partnerId]);

  const routeHasName = hasRealName(routePartnerName);
  // A route that carries our own label ("You") also carries our own picture —
  // ignore both and resolve the peer from the thread/presence/profile.
  const routeIsSelf = isSelfLabel(routePartnerName);
  const routePicture = routeIsSelf ? '' : routePartnerPicture;
  const [fetchedUser, setFetchedUser] = useState(null);

  useEffect(() => {
    setFetchedUser(null);
    if (!partnerId || routeHasName) return undefined;
    let live = true;
    getPublicUser(partnerId)
      .then(u => { if (live && u) setFetchedUser(u); })
      .catch(() => {});
    return () => { live = false; };
  }, [partnerId, routeHasName]);

  const fetchedMatches = fetchedUser && String(fetchedUser._id || fetchedUser.id || '') === partnerId;
  const fetchedName = fetchedMatches
    ? ([fetchedUser.firstName, fetchedUser.lastName].filter(Boolean).join(' ').trim()
        || fetchedUser.username
        || '')
    : '';

  const partnerName = routeHasName
    ? routePartnerName
    : (peerInfo?.name || presence[partnerId]?.name || fetchedName
      || (routeIsSelf ? '' : routePartnerName) || 'Chat');
  const partnerPicture = routePicture
    || peerInfo?.picture
    || (fetchedMatches ? fetchedUser.profilePicture : null)
    || null;
  const displayName = useMemo(() => safeName(partnerName), [partnerName]);

  // Peer typing (messages.js `_applyTypingState`): the row exists only while
  // the other side is signalling; the name falls back to what the route gave us.
  const typing = typingRows[partnerId];
  const typingLabel = `${typing?.name || displayName} is typing.`;

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // ─── Photo viewer ──────────────────────────────────────────────────────────
  // Tapping a photo (an image bubble or a listing card's thumbnail) opens the
  // edge-to-edge modal with the poster's avatar and name over it. `media` is
  // deliberately kept after closing so the fade-out still has something to show.
  const [media, setMedia] = useState(null);
  const [mediaOpen, setMediaOpen] = useState(false);

  const openPhoto = useCallback(msg => {
    if (!msg) return;
    let uri = '';
    let caption = '';
    if (msg.messageType === 'group-listing' && msg.listing?.imageUrl) {
      uri = msg.listing.imageUrl;
      caption = msg.listing.title || '';
    } else if (msg.messageType === 'image' && msg.attachment?.url) {
      uri = msg.attachment.url;
      caption = msg.text || '';
    }
    if (!uri) return;

    const mine = !!me && String(msg.senderId) === String(me);
    const s = msg.senderInfo || {};
    const peerName = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();

    setMedia({
      uri,
      caption,
      author: mine
        ? { name: `${firstName || ''} ${lastName || ''}`.trim() || 'You', avatar: null }
        : { name: peerName || msg.senderName || displayName, avatar: s.profilePicture || partnerPicture || null },
    });
    setMediaOpen(true);
  }, [me, firstName, lastName, displayName, partnerPicture]);

  // ─── Digital delivery download ─────────────────────────────────────────────
  // 'digital_delivery' bubbles carry the URL on message.digital (never in the
  // text); this saves it to cache and hands it to the OS share sheet — the
  // exact same flow as the Deals screen's Download button.
  const downloadDigital = useCallback(async msg => {
    const digital = msg?.digital || {};
    const url = digital.downloadUrl;
    if (!url) {
      setToast({ message: 'Download link missing from this message.', tone: 'danger' });
      return;
    }
    const label = digital.transactionId || 'download';
    const res = await saveDigitalDownload(absUrl(url), label, {
      fileName: digital.fileName,
      onStatus: (message, tone) => setToast({ message, tone }),
      // Messages sent before the streaming route carry a dead fl_attachment
      // URL — re-mint the signed link and retry once.
      refreshUrl: digital.transactionId
        ? async () => {
            const fresh = await fetchDownloadLink(digital.transactionId);
            return fresh?.downloadUrl
              ? { url: absUrl(fresh.downloadUrl), fileName: fresh.fileName || digital.fileName }
              : null;
          }
        : undefined,
    });
    if (!res.ok) setToast({ message: res.error || 'Download failed.', tone: 'danger' });
  }, []);

  // Known block state before the menu is opened (chats.js:1935-1946).
  useEffect(() => {
    if (!partnerId || !me) return undefined;
    let live = true;
    getBlockedStatus(partnerId)
      .then(d => { if (live && d) setBlocked(!!d.blocked); })
      .catch(() => {});
    return () => { live = false; };
  }, [partnerId, me]);

  useEffect(() => {
    if (!partnerId) return undefined;
    openDm(partnerId);
    markThreadSeen(partnerId);
    return () => closeThread({ partnerId });
  }, [partnerId, openDm, markThreadSeen, closeThread]);

  // Mark everything read on mount and whenever the thread first renders, since
  // the initial load is what reveals the unread messages.
  useEffect(() => {
    if (!loading && messages.length) markThreadSeen(partnerId);
  }, [loading, messages.length, partnerId, markThreadSeen]);

  // Web-parity presence: ask on open and re-ask every 60s so a stale last-seen
  // reading refreshes on its own (chats.js:1745, :1883-1887). requestPresence
  // throttles to one call per user per 5s, so the interval is cheap.
  const socketConnected = socketState === 'connected';

  useEffect(() => {
    if (!partnerId) return undefined;
    requestPresence([partnerId]);
    const t = setInterval(() => requestPresence([partnerId]), 60000);
    return () => clearInterval(t);
  }, [partnerId, requestPresence]);

  // Reconnect re-syncs status the same way the web's connect handler does.
  useEffect(() => {
    if (socketConnected && partnerId) requestPresence([partnerId]);
  }, [socketConnected, partnerId, requestPresence]);

  // Keep the newest message visible when the keyboard opens (inverted list ⇒
  // offset 0 is the bottom / newest).
  useEffect(() => {
    if (keyboardOpen) {
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
    }
  }, [keyboardOpen]);

  const data = useMemo(() => withDividers(messages).reverse(), [messages]);

  // chats.js:500-508 — every keystroke signals typing; the context throttles
  // the emit and pushes the 2s auto-stop itself.
  const onChange = useCallback(v => {
    setText(v);
    noteTyping('dm', partnerId);
  }, [noteTyping, partnerId]);

  const onSend = useCallback(async () => {
    const body = text.trim();
    if (!partnerId) return;
    if (!body && !pendingImage) return;

    // chats.js:1640-1646 — flagged text never leaves the device, and the draft
    // is kept so the user can edit around the violation.
    const scan = body ? scanContent(body) : { blocked: false, violations: [] };
    if (scan.blocked) {
      setToast({ message: scan.violations[0] || 'This message is blocked for safety.', tone: 'danger' });
      return;
    }

    const reply = replyTo && replyTo._id ? {
      replyTo: replyTo._id,
      replySenderName: replySenderName(replyTo),
      replyPreviewText: replyPreview(replyTo),
    } : {};

    if (pendingImage) {
      const media = pendingImage;
      setPendingImage(null);
      setText('');
      setReplyTo(null);
      const res = await sendDmImage(partnerId, media, body, reply);
      // A socket failure parks the row as "failed" (visible in the list); only
      // a vanished upload needs saying out loud.
      if (res?.error) setToast({ message: res.error, tone: 'danger' });
      return;
    }

    setText('');
    setReplyTo(null);
    // AI handoff: the first message is linked to the product it was opened
    // about, so "what did the bag seller say?" can find this thread later.
    const linkedProductId = aiProductCard?.productId && /^[a-fA-F0-9]{24}$/.test(String(aiProductCard.productId))
      ? String(aiProductCard.productId) : null;
    const linkMeta = linkedProductId
      ? { metadata: { productId: linkedProductId, source: 'ai_enquiry' } }
      : {};
    // The first send also carries the product photo as the bubble image so the
    // seller sees what the buyer wants. Remote URL — never a local path.
    const productUrl = aiProductCard?.imageUrl ? String(aiProductCard.imageUrl) : '';
    if (productUrl && /^https?:\/\//i.test(productUrl)) {
      setAiProductCard(null);
      sendDmText(partnerId, body, {
        ...reply,
        ...linkMeta,
        messageType: 'image',
        attachment: { url: productUrl, type: 'image' },
      });
      return;
    }
    setAiProductCard(null);
    sendDmText(partnerId, body, { ...reply, ...linkMeta });
  }, [text, partnerId, pendingImage, replyTo, sendDmText, sendDmImage, aiProductCard]);

  const onCancelReply = useCallback(() => setReplyTo(null), []);

  const onAttach = useCallback(async () => {
    if (!canSendDm || blocked) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setToast({ message: 'Photo library permission is required to send an image.', tone: 'danger' });
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (res.canceled) return;
    const asset = res.assets && res.assets[0];
    if (!asset?.uri) return;
    setPendingImage({ uri: asset.uri, fileName: asset.fileName, mimeType: asset.mimeType });
  }, [canSendDm, blocked]);

  // Long-press opens an in-app action sheet (Reply / Copy), replacing the old
  // Alert — alerts cannot show a preview and look nothing like the rest of the
  // chat surface.
  const onLongPressMessage = useCallback(item => {
    if (!item || item.isDeleted || item.kind === 'divider') return;
    if (!item._id && !item.tempId) return;
    setActionMsg(item);
  }, []);

  const closeAction = useCallback(() => setActionMsg(null), []);

  const onActionReply = useCallback(() => {
    if (actionMsg) setReplyTo(actionMsg);
    setActionMsg(null);
  }, [actionMsg]);

  const onActionCopy = useCallback(async () => {
    const body = (actionMsg?.text || '').trim();
    setActionMsg(null);
    if (!body) {
      setToast({ message: 'This message has no text to copy.', tone: 'danger' });
      return;
    }
    await Clipboard.setStringAsync(body);
    setToast({ message: 'Message copied.', tone: 'success' });
  }, [actionMsg]);

  const submitReport = useCallback(async () => {
    const reason = reportReason.trim();
    if (!reason) {
      setToast({ message: 'Please enter a reason for reporting', tone: 'danger' });
      return;
    }
    setReportBusy(true);
    try {
      const d = await reportChatUser(partnerId, reason, me);
      setReportOpen(false);
      setReportReason('');
      // chats.js:2352 keys everything off data.success.
      setToast(d?.success
        ? { message: 'User reported successfully.', tone: 'success' }
        : { message: d?.message || 'Failed to report user.', tone: 'danger' });
    } catch (err) {
      setToast({ message: 'An error occurred while reporting the user.', tone: 'danger' });
    } finally {
      setReportBusy(false);
    }
  }, [reportReason, partnerId, me]);

  const confirmBlockToggle = useCallback(() => {
    if (blocked) {
      Alert.alert(
        'Unblock user?',
        `Unblock ${displayName}? They'll be able to message you again.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Unblock',
            onPress: async () => {
              try {
                await unblockChatUser(partnerId);
                notifyBlock(partnerId, false);
                setBlocked(false);
                setToast({ message: `${displayName} unblocked.`, tone: 'success' });
              } catch (err) {
                setToast({ message: err?.message || 'Failed to unblock user.', tone: 'danger' });
              }
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      'Block user?',
      `Are you sure you want to block ${displayName}? You won't be able to message each other.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              const d = await blockChatUser(me, partnerId);
              // chats.js:2361 — only a truthy success closes the chat.
              if (!d?.success) {
                setToast({ message: d?.message || 'Failed to block user.', tone: 'danger' });
                return;
              }
              notifyBlock(partnerId, true);
              setBlocked(true);
              setToast({ message: 'User blocked successfully.', tone: 'success' });
              // chats.js closes the conversation after a successful block.
              back();
            } catch (err) {
              setToast({ message: 'An error occurred while blocking the user.', tone: 'danger' });
            }
          },
        },
      ],
    );
  }, [blocked, displayName, partnerId, me, back]);

  // ── Sidebar actions ────────────────────────────────────────────────────────
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const onViewProfile = useCallback(() => {
    setMenuOpen(false);
    nav.push('profile', { userId: partnerId, name: partnerName, profilePicture: partnerPicture });
  }, [nav, partnerId, partnerName, partnerPicture]);

  const onToggleMute = useCallback(() => {
    setMuted(m => {
      const next = !m;
      setToast({ message: next ? 'Notifications muted for this chat.' : 'Notifications unmuted.', tone: 'success' });
      return next;
    });
    setMenuOpen(false);
  }, []);

  const onBlockFromMenu = useCallback(() => {
    setMenuOpen(false);
    confirmBlockToggle();
  }, [confirmBlockToggle]);

  const onReportFromMenu = useCallback(() => {
    setMenuOpen(false);
    setReportReason('');
    setReportOpen(true);
  }, []);

  const onLoadOlder = useCallback(async () => {
    if (!messages.length) return;
    await loadOlderDm(partnerId);
    // The list is inverted, so "older" content is appended at the far end.
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [messages.length, partnerId, loadOlderDm]);

  const renderItem = useCallback(({ item }) => {
    if (item.kind === 'divider') {
      return <DateDivider value={item.at} />;
    }
    const mine = !!me && String(item.senderId) === String(me);
    const senderName = [item.senderInfo?.firstName, item.senderInfo?.lastName]
      .filter(Boolean).join(' ') || item.senderName || '';
    return (
      <MessageBubble
        message={item}
        mine={mine}
        showSender={false}
        senderName={senderName}
        onRetry={() => retryDm(partnerId, item.tempId)}
        onLongPress={() => onLongPressMessage(item)}
        onReply={blocked ? undefined : () => setReplyTo(item)}
        onOpenImage={openPhoto}
        onDownload={downloadDigital}
        onOpenLink={openSalmartLink}
      />
    );
  }, [me, partnerId, retryDm, onLongPressMessage, blocked, openPhoto, downloadDigital, openSalmartLink]);

  if (!partnerId) {
    return (
      <SafeAreaView style={styles.safe} edges={embedded ? [] : ['top', 'bottom']}>
        <HeaderBar onBack={back} onInfo={undefined} title={displayName} />
        <EmptyState icon="alert-circle-outline" title="Unknown conversation" message="This chat link is missing its participant." />
      </SafeAreaView>
    );
  }

  // Keyboard open → reserve only what it really covers; closed → safe-area inset.
  const bottomPad = keyboardOpen ? overlap : insets.bottom;
  const offline = socketState === 'unavailable' || socketState === 'error';
  // The empty/error state lives OUTSIDE the inverted list so it can never be
  // rendered upside down.
  const showEmpty = !loading && messages.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <SalmartChatBackground T={T} />
      <View style={[styles.headerWrap, { paddingTop: insets.top }]}>
        <HeaderBar
          onBack={back}
          onInfo={onViewProfile}
          onMenu={openMenu}
          title={displayName}
          picture={partnerPicture}
          offline={offline}
          subtitle={
            <PresenceStatus
              name={displayName}
              presence={presence[partnerId]}
              typing={!!typing && !blocked}
              socketConnected={socketConnected}
            />
          }
        />
      </View>

      <View ref={boxRef} collapsable={false} onLayout={onBoxLayout} style={styles.flex}>
        {/* The list stays mounted so the first message arrives at the bottom
            like every other one; the empty/error state is an overlay on top. */}
        <View style={styles.flex}>
          <FlatList
            ref={listRef}
            style={styles.flex}
            data={data}
            inverted
            keyExtractor={item => (item.kind === 'divider' ? item.key : `m-${item.key}`)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onEndReached={onLoadOlder}
            onEndReachedThreshold={0.4}
            removeClippedSubviews={true}
            initialNumToRender={14}
            maxToRenderPerBatch={10}
            windowSize={7}
            updateCellsBatchingPeriod={50}
          />
          {showEmpty ? (
            <View style={styles.emptyWrap} pointerEvents="box-none">
              {error ? (
                <ErrorState error={error} onRetry={() => openDm(partnerId)} />
              ) : (
                <WelcomeFlip
                  name={displayName}
                  picture={partnerPicture}
                  offline={offline}
                  blocked={blocked}
                />
              )}
            </View>
          ) : null}
        </View>

        {!canSendDm ? (
          <View style={styles.warnBar}>
            <Ionicons name="cloud-offline-outline" size={14} color={T.warning} />
            <Tiny style={{ color: T.warning, marginLeft: 6, flex: 1 }}>
              Live sending is unavailable — messages cannot be sent right now.
            </Tiny>
          </View>
        ) : null}

        {/* Reply preview — web keeps it inside the composer (chats.js:1660). */}
        {replyTo ? (
          <View style={styles.replyBar}>
            <Ionicons name="arrow-undo" size={15} color={T.emerald} />
            <View style={{ flex: 1, marginLeft: T.space.sm }}>
              <Tiny style={styles.replyName}>{replySenderName(replyTo)}</Tiny>
              <Tiny numberOfLines={1} style={styles.replyText}>{replyPreview(replyTo)}</Tiny>
            </View>
            <Pressable
              onPress={onCancelReply}
              hitSlop={10}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Cancel reply"
            >
              <Ionicons name="close-circle" size={19} color={T.inkSubtle} />
            </Pressable>
          </View>
        ) : null}

        {/* AI handoff product card — the photo that will attach to the next send. */}
        {aiProductCard?.imageUrl && !pendingImage ? (
          <View style={styles.replyBar}>
            <Image source={{ uri: String(aiProductCard.imageUrl) }} style={{ width: 44, height: 44, borderRadius: 8 }} contentFit="cover" />
            <View style={{ flex: 1, marginLeft: T.space.sm }}>
              <Tiny style={styles.replyName} numberOfLines={1}>
                {aiProductCard.title || 'Item you asked about'}
              </Tiny>
              <Tiny numberOfLines={1} style={styles.replyText}>Photo will send with your message</Tiny>
            </View>
            <Pressable
              onPress={() => setAiProductCard(null)}
              hitSlop={10}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Remove item photo"
            >
              <Ionicons name="close-circle" size={19} color={T.inkSubtle} />
            </Pressable>
          </View>
        ) : null}

        {/* Chosen photo — shows above the composer until sent or cancelled. */}
        {pendingImage ? (
          <View style={styles.pendingRow}>
            <Image source={{ uri: pendingImage.uri }} style={styles.pendingThumb} contentFit="cover" />
            <View style={{ flex: 1, marginHorizontal: T.space.sm }}>
              <Tiny style={styles.pendingTitle}>Photo ready to send</Tiny>
              <Tiny numberOfLines={1} style={styles.pendingSub}>
                {text.trim() ? `Caption: ${text.trim()}` : 'Tap send to share without a caption'}
              </Tiny>
            </View>
            <Pressable
              onPress={() => setPendingImage(null)}
              hitSlop={10}
              style={{ padding: 6 }}
              accessibilityRole="button"
              accessibilityLabel="Remove photo"
            >
              <Ionicons name="close-circle" size={22} color={T.inkSubtle} />
            </Pressable>
          </View>
        ) : null}

        {muted ? (
          <View style={styles.muteBar}>
            <Ionicons name="notifications-off-outline" size={13} color={T.inkSubtle} />
            <Tiny style={{ color: T.inkSubtle, marginLeft: 6 }}>
              Notifications muted for this chat
            </Tiny>
          </View>
        ) : null}

        <TypingDots visible={!!typing && !blocked} label={typingLabel} />

        <ChatComposer
          value={text}
          onChangeText={onChange}
          onSend={onSend}
          onAttach={onAttach}
          forceSend={!!pendingImage}
          disabled={!canSendDm || blocked}
          placeholder={blocked ? 'You blocked this user' : `Message ${displayName}`}
        />
        {/* Keyboard/safe-area spacer — the one mechanism that keeps the composer
            above the keyboard (see useKeyboardOverlap). It sits inside the
            measured box, so it never changes the box's own size. Transparent so
            the chat scene shows through to the bottom edge. */}
        <View style={{ height: bottomPad }} />
      </View>

      {/* Conversation sidebar (replaces the old Alert menu). */}
      <SideDrawer visible={menuOpen} onClose={closeMenu} width={drawerWidth} insets={insets}>
        <View style={styles.drawerHeader}>
          <Avatar uri={partnerPicture} name={displayName} size={64} />
          <T2 numberOfLines={1} style={styles.drawerName}>{displayName}</T2>
          <PresenceStatus
            name={displayName}
            presence={presence[partnerId]}
            typing={!!typing && !blocked}
            socketConnected={socketConnected}
          />
        </View>

        <View style={styles.drawerBody}>
          <DrawerItem icon="person-outline" label="View profile" onPress={onViewProfile} />
          <DrawerItem
            icon={muted ? 'notifications-outline' : 'notifications-off-outline'}
            label={muted ? 'Unmute notifications' : 'Mute notifications'}
            onPress={onToggleMute}
          />
          <DrawerItem
            icon={blocked ? 'lock-open-outline' : 'ban-outline'}
            label={blocked ? 'Unblock user' : 'Block user'}
            onPress={onBlockFromMenu}
            danger={!blocked}
          />
          <DrawerItem icon="flag-outline" label="Report user" onPress={onReportFromMenu} danger />
        </View>
      </SideDrawer>

      {/* Long-press message actions. */}
      <Sheet visible={!!actionMsg} onClose={closeAction} title="Message">
        <View style={styles.actionPreview}>
          <Tiny style={styles.actionPreviewName}>{replySenderName(actionMsg || {})}</Tiny>
          <Small numberOfLines={2} style={styles.actionPreviewText}>
            {replyPreview(actionMsg || {})}
          </Small>
        </View>
        <DrawerItem icon="arrow-undo-outline" label="Reply" onPress={onActionReply} />
        <DrawerItem icon="copy-outline" label="Copy text" onPress={onActionCopy} />
      </Sheet>

      {/* Free-text report modal — messages-reportConfirmationModal. */}
      <Sheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report user"
        footer={(
          <Row gap={T.space.sm}>
            <Button
              title="Cancel"
              variant="secondary"
              full={false}
              style={{ flex: 1 }}
              onPress={() => setReportOpen(false)}
            />
            <Button
              title="Submit report"
              full={false}
              style={{ flex: 1 }}
              loading={reportBusy}
              onPress={submitReport}
            />
          </Row>
        )}
      >
        <Tiny style={{ color: T.inkMuted, marginBottom: 6 }}>
          {`REPORTING ${String(displayName || 'this user').toUpperCase()}`}
        </Tiny>
        <Input
          value={reportReason}
          onChangeText={setReportReason}
          placeholder="Why are you reporting this user?"
          autoCapitalize="sentences"
          multiline
          numberOfLines={4}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
        />
        <Tiny style={{ color: T.inkSubtle, marginTop: T.space.sm }}>
          Our team reviews every report. False reports may restrict your account.
        </Tiny>
      </Sheet>

      <MediaViewer
        visible={mediaOpen}
        uri={media?.uri}
        author={media?.author}
        caption={media?.caption}
        onClose={() => setMediaOpen(false)}
      />

      <Toast visible={!!toast} message={toast?.message} tone={toast?.tone} />
    </SafeAreaView>
  );
}

function HeaderBar({ onBack, onInfo, onMenu, title, picture, subtitle, offline }) {
  const { T } = useTheme();
  const styles = useStyles();

  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        hitSlop={10}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Ionicons name="chevron-back" size={26} color={T.ink} />
      </Pressable>

      <View style={styles.headerCenter} pointerEvents="box-none">
        <Pressable
          onPress={onInfo}
          style={styles.identityPill}
          accessibilityRole="button"
          accessibilityLabel={`View ${title}'s profile`}
        >
          <Avatar uri={picture} name={title} size={34} />

          <View style={styles.identityMeta}>
            <View style={styles.titleRow}>
              <Tiny numberOfLines={1} style={styles.hdrTitle}>{title}</Tiny>
              {offline ? <Ionicons name="cloud-offline-outline" size={12} color={T.inkMuted} /> : null}
            </View>
            <View style={styles.subtitleRow}>{subtitle}</View>
          </View>
        </Pressable>
      </View>

      <View style={styles.headerActions}>
        {onInfo ? (
          <Pressable
            onPress={onInfo}
            hitSlop={10}
            style={styles.hdrBtn}
            accessibilityRole="button"
            accessibilityLabel="View profile"
          >
            <Ionicons name="information-circle-outline" size={21} color={T.inkMuted} />
          </Pressable>
        ) : null}

        {onMenu ? (
          <Pressable
            onPress={onMenu}
            hitSlop={10}
            style={styles.hdrBtn}
            accessibilityRole="button"
            accessibilityLabel="Conversation menu"
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={T.inkMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SalmartChatBackground({ T }) {
  const styles = useStyles();

  return (
    <View pointerEvents="none" style={styles.sceneWrap}>
      <View style={[styles.sceneOrb, styles.orbOne, { backgroundColor: T.emerald }]} />
      <View style={[styles.sceneOrb, styles.orbTwo, { backgroundColor: T.info || '#22c55e' }]} />
      <View style={[styles.sceneOrb, styles.orbThree, { backgroundColor: T.emerald }]} />
      <View style={styles.sceneGlow} />
    </View>
  );
}

/** Right-hand slide-in drawer with a tap-to-dismiss scrim. */
function SideDrawer({ visible, onClose, width, insets, children }) {
  const { T } = useTheme();
  const styles = useStyles();
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible, anim]);

  if (!mounted) return null;

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [width, 0] });
  const scrimOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          { width, paddingTop: insets.top + T.space.md, transform: [{ translateX }] },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function DrawerItem({ icon, label, onPress, danger }) {
  const { T } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.drawerItem, pressed && styles.drawerItemPressed]}
    >
      <Ionicons name={icon} size={21} color={danger ? T.danger : T.inkMuted} />
      <Small style={[styles.drawerItemLabel, danger && { color: T.danger }]}>{label}</Small>
    </Pressable>
  );
}

/** Friendly, clearly-worded empty state for a thread with no messages yet. */
function WelcomeFlip({ name, picture, offline, blocked }) {
  const styles = useStyles();
  const message = blocked
    ? `You blocked ${name}. Unblock them from the menu to start chatting again.`
    : offline
      ? 'You are offline. Your messages will send once the connection is back.'
      : 'This is the start of your conversation. Say hello to get things going.';
  return (
    <View style={styles.emptyFlip}>
      <View style={styles.welcome}>
        <Avatar uri={picture} name={name} size={72} />
        <T2 style={styles.welcomeTitle}>{name}</T2>
        <Small style={styles.welcomeText}>{message}</Small>
      </View>
    </View>
  );
}

/** Same key derivation ChatContext uses, kept local to avoid a cross-import. */
function chatKey(me, partnerId) {
  if (!me || !partnerId) return 'dm:invalid';
  return [String(me), String(partnerId)].sort().join('_');
}

const useStyles = createThemed(({ T, isDark }) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bgAlt },
  headerWrap: {
    backgroundColor: 'transparent',
  },
  flex: { flex: 1 },
  listContent: { paddingVertical: T.space.md },

  sceneWrap: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    backgroundColor: T.bgAlt,
  },
  sceneOrb: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.22,
  },
  orbOne: { width: 320, height: 320, top: -80, left: -40 },
  orbTwo: { width: 260, height: 260, right: -30, top: 140 },
  orbThree: { width: 240, height: 240, left: '28%', bottom: -30 },
  sceneGlow: { ...StyleSheet.absoluteFillObject },
  scenePattern: { ...StyleSheet.absoluteFillObject },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: T.space.sm,
    paddingVertical: T.space.sm,
    backgroundColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.border,
  },
  headerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', minWidth: 0, paddingHorizontal: 8 },
  identityPill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
    paddingLeft: 4,
    paddingRight: 14,
    borderRadius: 22,
    backgroundColor: T.bgSoft,
    borderWidth: 1,
    borderColor: T.border,
    maxWidth: '100%',
  },
  identityMeta: { flexShrink: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  hdrTitle: { fontSize: 15, fontWeight: '700', color: T.ink, textAlign: 'center' },
  subtitleRow: { alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, zIndex: 2 },
  hdrBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: T.bgSoft,
  },
  backBtn: { padding: 6, zIndex: 2 },

  warnBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.space.md,
    paddingVertical: T.space.sm,
    backgroundColor: T.tint('warning'),
  },
  muteBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: T.space.xs,
    backgroundColor: T.bgAlt,
  },

  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.space.md,
    paddingVertical: T.space.sm,
    backgroundColor: T.bgSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.border,
  },
  replyName: { color: T.emerald, fontWeight: '700' },
  replyText: { color: T.inkMuted, marginTop: 2 },

  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.space.md,
    paddingVertical: T.space.sm,
    backgroundColor: T.bgSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.border,
  },
  pendingThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: T.bg,
  },
  pendingTitle: { color: T.ink, fontWeight: '700' },
  pendingSub: { color: T.inkSubtle, marginTop: 2 },

  // Empty/error state is a sibling of the list (not inside the inverted
  // FlatList), so no counter-flip is needed.
  emptyWrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'center' },
  emptyFlip: { flex: 1 },
  welcome: {
    alignItems: 'center',
    paddingHorizontal: T.space.xl,
    paddingVertical: T.space.xl,
  },
  welcomeTitle: { color: T.ink, marginTop: T.space.md, textAlign: 'center' },
  welcomeText: { color: T.inkMuted, marginTop: T.space.sm, textAlign: 'center', lineHeight: 20 },

  // ── Sidebar ────────────────────────────────────────────────────────────────
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  drawer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: T.card,
    ...shadow(3),
  },
  drawerHeader: {
    alignItems: 'center',
    paddingHorizontal: T.space.lg,
    paddingBottom: T.space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.border,
  },
  drawerName: { color: T.ink, marginTop: T.space.md, textAlign: 'center' },
  drawerBody: { paddingVertical: T.space.sm },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.space.md,
    paddingHorizontal: T.space.lg,
    paddingVertical: T.space.md,
  },
  drawerItemPressed: { backgroundColor: T.bgSoft },
  drawerItemLabel: { color: T.ink, fontWeight: '600' },

  actionPreview: {
    backgroundColor: T.bgSoft,
    borderRadius: T.radius.md,
    borderLeftWidth: 3,
    borderLeftColor: T.emerald,
    paddingHorizontal: T.space.md,
    paddingVertical: T.space.sm,
    marginBottom: T.space.sm,
  },
  actionPreviewName: { color: T.emerald, fontWeight: '700' },
  actionPreviewText: { color: T.inkMuted, marginTop: 2 },
}));
