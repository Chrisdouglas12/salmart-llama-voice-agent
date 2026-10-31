import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Platform, Pressable, StyleSheet, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme/theme';
import { useNavActions, useNavSelector } from '../state/Navigation';
import { Small, Tiny } from '../ui/kit';
import { useAI } from './AIContext';
import { useSplashVisible } from '../state/splash';

/**
 * Floating microphone button.
 *
 * Tap: start or stop one voice turn on the current screen. The transcript goes
 * to /api/ai, the reply is spoken, and any actions run in place. A tap does not
 * open the AI screen.
 * Hold: open the full AI conversation with the current screen as context. A
 * long press does not also start a recording.
 *
 * The card above the button shows live status, the spoken reply, a Google
 * sign-in action, and Confirm/Cancel for actions that need approval.
 */

const WINDOW_WIDTH = Dimensions.get('window').width;
const LONG_PRESS_MS = 450;

// The server prompt calls the create-ad form `create_ad`; every other screen
// uses its route key (createRequest, editProfile, checkout, ...). The platform
// is sent on every turn so the backend can build the right Google URL even
// when the model leaves it out.
function screenContext(name, params) {
  const out = { platform: Platform.OS };
  if (name) out.screen = name === 'createAd' ? 'create_ad' : String(name).slice(0, 120);
  // In a chat thread, send the partner id so "what did the seller say?"
  // resolves without asking the user for an id.
  const pid = params?.partnerId || params?.userId || params?.id;
  if (name === 'chat' && pid) out.chatPartnerId = String(pid).slice(0, 24);
  return out;
}

export default function AIModeButton({ extraContext } = {}) {
  const { T } = useTheme();
  const currentName = useNavSelector(s => s.current.name);
  const currentParams = useNavSelector(s => s.current.params);
  const inWeb = useNavSelector(s => s.inWeb);
  const nav = useNavActions();
  const {
    recording, transcribing, status, lastVoice,
    toggleRecording, dismissVoice, confirmVoice, cancelVoice,
    startGoogleAuth, authBusy, micNudge,
  } = useAI();

  const [actionBusy, setActionBusy] = useState(null);
  const longPressedRef = useRef(false);
  const splashVisible = useSplashVisible();
  const sending = status === 'sending';
  const busy = recording || transcribing || sending;
  // Gentle attention pulse from the welcome nudge: three slow scales, then
  // rest. The label ("Tap to talk") stays visible until the user records or
  // 12 seconds pass.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const [nudgeVisible, setNudgeVisible] = useState(false);
  useEffect(() => {
    if (!micNudge || recording || transcribing || sending) return undefined;
    setNudgeVisible(true);
    pulseAnim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
      { iterations: 3 },
    );
    loop.start();
    const timer = setTimeout(() => setNudgeVisible(false), 12000);
    return () => { loop.stop(); clearTimeout(timer); };
  }, [micNudge, recording, transcribing, sending, pulseAnim]);
  const pulseScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  // Always-on invitation glow: a soft brand halo that keeps breathing from
  // under the mic. A first-time user reads the animated green bubble as "tap
  // me" before the welcome nudge fires. It is native-driven, so it does not
  // block the tap or cost JS frames.
  const glowAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const useNative = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1400, useNativeDriver: useNative }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1400, useNativeDriver: useNative }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim]);
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.34, 0.02] });
  const glowScale = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] });

  const confirmation = lastVoice?.confirmation || null;
  const authBlock = lastVoice?.authUrl || null;

  // A plain reply should not stay over the app forever. Confirmations and a
  // Google sign-in action stay until the user acts on them.
  useEffect(() => {
    if (!lastVoice?.text || confirmation || authBlock || busy) return undefined;
    const timer = setTimeout(() => dismissVoice(), 10000);
    return () => clearTimeout(timer);
  }, [lastVoice, confirmation, authBlock, busy, dismissVoice]);

  // Hide on the launch splash, the AI screen (it has its own input), the
  // legacy assistant screen, and inside the WebView.
  if (splashVisible || currentName === 'ai' || currentName === 'assistant' || inWeb) return null;

  const showCard = busy || !!lastVoice?.text || !!confirmation || !!authBlock;

  const statusLabel = recording
    ? 'Listening…'
    : transcribing
      ? 'Transcribing…'
      : sending
        ? 'Thinking…'
        : 'Salmart AI';

  const body = recording
    ? "I'm listening. Just stop talking and I'll pick it up — or tap the button."
    : transcribing
      ? "Got it. I'm understanding you. Please wait a moment."
      : sending
        ? "I'm understanding you. Please wait a moment."
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

  // A long press opens the full conversation and must not also record.
  // React Native still fires onPress after a long press, so this swallows the
  // next tap.
  const onLongPressMic = () => {
    if (busy) return;
    longPressedRef.current = true;
    nav.push('ai', {
      ...(currentName ? { screen: currentName } : {}),
      ...(currentName === 'chat' && currentParams?.partnerId
        ? { chatPartnerId: String(currentParams.partnerId).slice(0, 24) }
        : {}),
      ...(extraContext || {}),
    });
  };

  // Messages has its own green "+" button at the bottom right, so lift the mic
  // clearly above it. Market no longer has a bottom-right FAB, but a small lift
  // keeps the mic from crowding the tab bar.
  const aboveScreenFab = currentName === 'messages';
  const screenLift = aboveScreenFab ? 72 : currentName === 'market' ? 28 : 0;
  const wrapBottom = (Platform.OS === 'ios' ? 100 : 90) + screenLift;
  const onPressMic = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    toggleRecording({ ...screenContext(currentName, currentParams), ...(extraContext || {}) });
  };

  return (
    <View style={[styles.wrap, { bottom: wrapBottom }]} pointerEvents="box-none">
      {!!(nudgeVisible && micNudge && !busy) && (
        <View style={[styles.nudge, { backgroundColor: T.card, borderColor: T.border }]}>
          <Tiny style={{ color: T.ink, fontWeight: '700' }}>{micNudge.label || 'Tap to talk'}</Tiny>
        </View>
      )}
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
        </View>
      )}

      <Animated.View style={{ transform: [{ scale: nudgeVisible && !busy ? pulseScale : 1 }] }}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.glow,
          {
            backgroundColor: recording ? T.danger : T.emerald,
            opacity: glowOpacity,
            transform: [{ scale: glowScale }],
          },
        ]}
      />
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
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 20,
    // `bottom` is set per screen (see wrapBottom). Screens with their own
    // bottom-right button get a larger lift so the mic sits above it.
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
    shadowColor: '#10B981',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  // Breathing halo behind the mic (see glowAnim). Same footprint as the fab so
  // the expansion stays centred on the button.
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  nudge: {
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    borderWidth: 1,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
});
