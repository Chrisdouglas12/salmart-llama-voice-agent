import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Dimensions, Platform, Pressable, StyleSheet, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme/theme';
import { useNavActions, useNavSelector } from '../state/Navigation';
import { Small, Tiny } from '../ui/kit';
import { useAI } from './AIContext';

/**
 * Global mic.
 *
 * Stays on the current screen: tap to talk, the transcript goes to /api/ai,
 * the reply is spoken with the server voice, and any action the turn triggered
 * runs where the user already is. It never pushes the AI screen on a tap.
 *
 * Hold the mic to open the full AI conversation instead, with the current
 * screen as context. A long press never also starts a recording.
 *
 * The compact card above the button shows live status, the spoken reply, a
 * Google handoff button, and Confirm/Cancel for actions that need the user's OK.
 */

const WINDOW_WIDTH = Dimensions.get('window').width;
const LONG_PRESS_MS = 450;

// The server prompt calls the create-ad form `create_ad`; every other screen
// uses its route key (createRequest, editProfile, checkout, ...). The platform
// is sent on every turn so the backend can build the right Google URL even
// when the model omits it.
function screenContext(name, params) {
  const out = { platform: Platform.OS };
  if (name) out.screen = name === 'createAd' ? 'create_ad' : String(name).slice(0, 120);
  // Chat thread: let "what did the seller say?" resolve without asking for ids.
  const pid = params?.partnerId || params?.userId || params?.id;
  if (name === 'chat' && pid) out.chatPartnerId = String(pid).slice(0, 24);
  return out;
}

export default function AIModeButton() {
  const { T } = useTheme();
  const currentName = useNavSelector(s => s.current.name);
  const currentParams = useNavSelector(s => s.current.params);
  const inWeb = useNavSelector(s => s.inWeb);
  const nav = useNavActions();
  const {
    recording, transcribing, status, lastVoice,
    toggleRecording, dismissVoice, confirmVoice, cancelVoice,
    startGoogleAuth, authBusy, openSellerChat,
  } = useAI();

  const [actionBusy, setActionBusy] = useState(null);
  const longPressedRef = useRef(false);

  const sending = status === 'sending';
  const busy = recording || transcribing || sending;
  const confirmation = lastVoice?.confirmation || null;
  const authBlock = lastVoice?.authUrl || null;
  const chatHandoff = lastVoice?.chatHandoff || null;
  // On the seller's own chat screen the handoff card is noise — you are
  // already there. The draft is pre-filled in the composer instead.
  const alreadyInHandoffChat = currentName === 'chat'
    && !!chatHandoff?.sellerId
    && String(currentParams?.partnerId || '') === String(chatHandoff.sellerId);

  // A plain reply should not sit over the app forever. Confirmations, a
  // Google handoff, and a seller-chat handoff stay until the user acts on them.
  useEffect(() => {
    if (!lastVoice?.text || confirmation || authBlock || (chatHandoff && !alreadyInHandoffChat) || busy) return undefined;
    const timer = setTimeout(() => dismissVoice(), 10000);
    return () => clearTimeout(timer);
  }, [lastVoice, confirmation, authBlock, chatHandoff, alreadyInHandoffChat, busy, dismissVoice]);

  // Hide on the AI screen (it has its own input), the legacy assistant screen,
  // and inside the WebView.
  if (currentName === 'ai' || currentName === 'assistant' || inWeb) return null;

  const showCard = busy || !!lastVoice?.text || !!confirmation || !!authBlock || (!!chatHandoff && !alreadyInHandoffChat);

  const statusLabel = recording
    ? 'Listening…'
    : transcribing
      ? 'Transcribing…'
      : sending
        ? 'Thinking…'
        : 'Salmart AI';

  const body = recording
    ? 'Tap the mic again when you are done.'
    : transcribing
      ? 'One moment…'
      : sending
        ? 'Working on it…'
        : (lastVoice?.text || '');

  const tone = recording || lastVoice?.kind === 'error' ? T.danger : T.emerald;

  const fabIcon = recording
    ? 'stop'
    : transcribing || sending
      ? 'ellipsis-horizontal'
      : 'mic';

  const runAction = async (which) => {
    if (actionBusy || !confirmation?.actionId) return;
    setActionBusy(which);
    try {
      if (which === 'confirm') await confirmVoice(confirmation.actionId);
      else await cancelVoice(confirmation.actionId);
    } finally {
      setActionBusy(null);
    }
  };

  const onGoogle = async () => {
    if (authBusy || !authBlock?.url) return;
    await startGoogleAuth({ url: authBlock.url, platform: authBlock.platform || Platform.OS });
  };

  // A long press opens the full conversation. It must not also record: RN
  // still fires onPress after a long press, so the tap is swallowed once.
  const onLongPressMic = () => {
    if (busy) return;
    longPressedRef.current = true;
    nav.push('ai', currentName ? {
      screen: currentName,
      ...(currentName === 'chat' && currentParams?.partnerId
        ? { chatPartnerId: String(currentParams.partnerId).slice(0, 24) }
        : {}),
    } : undefined);
  };

  const onOpenChat = () => {
    if (!chatHandoff) return;
    dismissVoice();
    openSellerChat(chatHandoff);
  };

  const onPressMic = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    toggleRecording(screenContext(currentName, currentParams));
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {showCard && (
        <View style={[styles.card, { backgroundColor: T.card, borderColor: T.border }]}>
          <View style={styles.head}>
            <Ionicons
              name={recording ? 'radio-button-on' : lastVoice?.kind === 'error' ? 'alert-circle-outline' : 'sparkles'}
              size={14}
              color={tone}
            />
            <Tiny style={{ color: T.inkMuted, flex: 1, marginLeft: 6 }} numberOfLines={1}>
              {statusLabel}
            </Tiny>
            {!busy && !confirmation && (
              <Pressable
                onPress={dismissVoice}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
              >
                <Ionicons name="close" size={16} color={T.inkMuted} />
              </Pressable>
            )}
          </View>

          {!!body && (
            <Small style={{ color: T.ink, marginTop: 6, lineHeight: 19 }}>
              {body}
            </Small>
          )}

          {!!confirmation && (
            <>
              <Tiny style={{ color: T.inkMuted, marginTop: 6, lineHeight: 16 }}>
                {confirmation.summary || 'This action needs your OK first.'}
              </Tiny>
              <View style={styles.actions}>
                <Pressable
                  onPress={() => runAction('cancel')}
                  disabled={!!actionBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel this action"
                  style={({ pressed }) => [
                    styles.actionBtn,
                    { backgroundColor: T.bgSoft, borderColor: T.border },
                    (pressed || actionBusy === 'cancel') && { opacity: 0.7 },
                  ]}
                >
                  {actionBusy === 'cancel'
                    ? <ActivityIndicator size="small" color={T.ink} />
                    : <Small style={{ color: T.ink, fontWeight: '700' }}>Cancel</Small>}
                </Pressable>
                <Pressable
                  onPress={() => runAction('confirm')}
                  disabled={!!actionBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm this action"
                  style={({ pressed }) => [
                    styles.actionBtn,
                    { backgroundColor: T.emerald, borderColor: T.emerald },
                    (pressed || actionBusy === 'confirm') && { opacity: 0.85 },
                  ]}
                >
                  {actionBusy === 'confirm'
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Small style={{ color: '#fff', fontWeight: '800' }}>Confirm</Small>}
                </Pressable>
              </View>
            </>
          )}

          {!!authBlock?.url && (
            <Pressable
              onPress={onGoogle}
              disabled={authBusy}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              style={({ pressed }) => [
                styles.googleBtn,
                { backgroundColor: T.card, borderColor: T.border },
                (pressed || authBusy) && { opacity: 0.75 },
              ]}
            >
              {authBusy
                ? <ActivityIndicator size="small" color={T.ink} />
                : <Ionicons name="logo-google" size={16} color={T.ink} />}
              <Small style={{ color: T.ink, fontWeight: '800', marginLeft: 8 }}>
                Continue with Google
              </Small>
            </Pressable>
          )}
          {!!chatHandoff && !confirmation && !alreadyInHandoffChat && (
            <Pressable
              onPress={onOpenChat}
              accessibilityRole="button"
              accessibilityLabel={`Open chat with ${chatHandoff.sellerName || 'seller'}`}
              style={({ pressed }) => [
                styles.googleBtn,
                { backgroundColor: T.emerald, borderColor: T.emerald },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="chatbubbles-outline" size={16} color="#fff" />
              <Small style={{ color: '#fff', fontWeight: '800', marginLeft: 8 }}>
                Open chat{chatHandoff.sellerName ? ` with ${chatHandoff.sellerName}` : ''}
              </Small>
            </Pressable>
          )}
        </View>
      )}

      <Pressable
        onPress={onPressMic}
        onLongPress={onLongPressMic}
        onPressIn={() => { longPressedRef.current = false; }}
        delayLongPress={LONG_PRESS_MS}
        accessibilityRole="button"
        accessibilityLabel={recording ? 'Stop talking to Salmart AI' : 'Talk to Salmart AI'}
        accessibilityHint="Tap to talk. Hold to open the Salmart AI screen."
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: recording ? T.danger : transcribing || sending ? T.inkMuted : T.emerald },
          pressed && { opacity: 0.85, transform: [{ scale: 0.95 }] },
        ]}
      >
        <Ionicons name={fabIcon} size={26} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 20,
    bottom: Platform.OS === 'ios' ? 100 : 90, // clears the tab bar safely
    alignItems: 'flex-end',
    zIndex: 9000,
  },
  card: {
    width: Math.min(WINDOW_WIDTH - 40, 340),
    marginBottom: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
  },
  fab: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
