/**
 * First-run voice onboarding.
 *
 * Shown once per install, on top of the app, after the launch splash hides.
 * It explains the voice assistant and asks for microphone permission before
 * the user reaches the sign-in screen.
 *
 * The welcome uses the same TTS and permission pipeline as the floating mic:
 * `speak()` from AIContext and expo-audio's recording permission request. No
 * second recorder or speech provider is created here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { requestRecordingPermissionsAsync } from 'expo-audio';

import { createThemed, useTheme } from '../theme/theme';
import { useSplashVisible } from '../state/splash';
import { useAI } from './AIContext';
import { stopSpeaking } from './speak';
import {
  FIRST_RUN_WELCOME,
  FIRST_RUN_THANKS,
  FIRST_RUN_DENIED,
  FIRST_RUN_ALLOW_HINT,
  hasSeenFirstRun,
  markFirstRunSeen,
} from './firstRun';

const RING_COUNT = 3;
const RING_DURATION = 2100;
const RING_STAGGER = 700;

export default function FirstRunWelcome() {
  const { T } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const splashVisible = useSplashVisible();
  const { speak, nudgeMic } = useAI();

  const [visible, setVisible] = useState(false);
  const [asking, setAsking] = useState(false);
  const decidedRef = useRef(false);
  const startedRef = useRef(false);
  const rings = useRef(
    Array.from({ length: RING_COUNT }, () => new Animated.Value(0)),
  ).current;

  // Wait for the splash to finish, then decide once whether this is a first run.
  useEffect(() => {
    if (splashVisible || startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;

    (async () => {
      const seen = await hasSeenFirstRun();
      if (cancelled || seen) return;
      setVisible(true);
      await speak(FIRST_RUN_WELCOME);
    })();

    return () => {
      cancelled = true;
    };
  }, [splashVisible, speak]);

  // A slow outward ring behind the mic, like the splash's single brand motion.
  useEffect(() => {
    if (!visible) return undefined;

    const loops = rings.map((value, index) => {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.delay(index * RING_STAGGER),
          Animated.timing(value, {
            toValue: 1,
            duration: RING_DURATION,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
          Animated.delay((RING_COUNT - 1 - index) * RING_STAGGER),
        ]),
      );
      animation.start();
      return animation;
    });

    return () => loops.forEach(animation => animation.stop());
  }, [visible, rings]);

  const closeAndRemember = useCallback(async () => {
    await markFirstRunSeen();
    setVisible(false);
    setAsking(false);
  }, []);

  const onAllow = useCallback(async () => {
    if (asking || decidedRef.current) return;
    decidedRef.current = true;
    setAsking(true);
    // The question has been answered; stop the welcome before the phone's
    // permission prompt appears so the two audio sources never overlap.
    await stopSpeaking();

    let granted = false;
    try {
      const permission = await requestRecordingPermissionsAsync();
      granted = !!permission?.granted;
    } catch (_e) {
      granted = false;
    }

    await closeAndRemember();
    if (granted) {
      nudgeMic('Tap to talk');
      await speak(FIRST_RUN_THANKS);
    } else {
      await speak(FIRST_RUN_DENIED);
    }
  }, [asking, closeAndRemember, nudgeMic, speak]);

  const onLater = useCallback(async () => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    await stopSpeaking();
    await closeAndRemember();
  }, [closeAndRemember]);

  if (!visible) return null;

  return (
    <View
      style={[styles.overlay, { backgroundColor: T.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}
      accessibilityViewIsModal
      importantForAccessibility="yes"
    >
      <ScrollView
        contentContainerStyle={styles.content}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoBadge}>
          <Image
            source={require('../../assets/salmart-logo-2.png')}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={0}
            style={styles.logo}
          />
        </View>
        <Text style={[styles.wordmark, { color: T.inkStrong }]}>Salmart</Text>

        <View style={styles.micStage}>
          {rings.map((value, index) => (
            <Animated.View
              key={index}
              pointerEvents="none"
              style={[
                styles.ring,
                {
                  borderColor: T.emerald,
                  opacity: value.interpolate({
                    inputRange: [0, 0.15, 1],
                    outputRange: [0, 0.4, 0],
                  }),
                  transform: [{
                    scale: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2.05],
                    }),
                  }],
                },
              ]}
            />
          ))}
          <View style={[styles.micOrb, { backgroundColor: T.emerald }]}>
            <Ionicons name="mic" size={38} color="#FFFFFF" />
          </View>
        </View>

        <Text style={[styles.body, { color: T.inkMuted }]}>{FIRST_RUN_WELCOME}</Text>

        <Text style={[styles.hint, { color: T.inkMuted }]}>{FIRST_RUN_ALLOW_HINT}</Text>

        <Pressable
          onPress={onAllow}
          disabled={asking}
          accessibilityRole="button"
          accessibilityLabel="Yes, allow me to speak"
          style={({ pressed }) => [
            styles.allowButton,
            { backgroundColor: T.emerald },
            pressed && !asking && styles.pressed,
            asking && styles.disabled,
          ]}
        >
          <Ionicons name="mic" size={20} color="#FFFFFF" />
          <Text style={styles.allowText}>
            {asking ? 'Waiting for permission…' : 'Yes, allow me to speak'}
          </Text>
        </Pressable>

        <Pressable
          onPress={onLater}
          disabled={asking}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Maybe later"
          style={({ pressed }) => [styles.later, pressed && styles.pressed]}
        >
          <Text style={[styles.laterText, { color: T.inkSubtle }]}>Maybe later</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9500,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 28,
  },
  logoBadge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: 'rgba(0, 168, 107, 0.35)',
    ...Platform.select({
      ios: {
        shadowColor: '#00A86B',
        shadowOpacity: 0.22,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 5 },
      },
      android: { elevation: 6 },
      default: {},
    }),
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  wordmark: {
    marginTop: 12,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  // Fixed square reserves the room the rings grow into, so the content below
  // never moves while the animation runs.
  micStage: {
    width: 190,
    height: 190,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  ring: {
    position: 'absolute',
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2,
  },
  micOrb: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 2,
    marginBottom: 10,
  },
  allowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    width: '100%',
    maxWidth: 360,
    minHeight: 54,
    borderRadius: 16,
    paddingHorizontal: 18,
  },
  allowText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.82,
  },
  disabled: {
    opacity: 0.7,
  },
  hint: {
    maxWidth: 320,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 18,
  },
  later: {
    marginTop: 16,
    paddingVertical: 6,
  },
  laterText: {
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
}));
