/**
 * Voice-help hint for the sign-in and registration screens.
 *
 * Shows a short line about the green mic button and a mute toggle. The spoken
 * welcome and mic pulse start once per mount through welcome.js; nothing here
 * records audio.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { createThemed, useTheme } from '../theme/theme';
import { Small } from '../ui/kit';
import { useAI } from './AIContext';
import { runAuthWelcome, isVoiceMuted, setVoiceMuted } from './welcome';

export default function AuthWelcome() {
  const { T } = useTheme();
  const styles = useStyles();
  const { nudgeMic } = useAI();
  const firedRef = useRef(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    isVoiceMuted().then(setMuted).catch(() => {});
    runAuthWelcome({ nudgeMic }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMute = async () => {
    const next = !muted;
    setMuted(next);
    try {
      await setVoiceMuted(next);
    } catch (_e) { /* prefs are best-effort */ }
  };

  return (
    <View style={[styles.row, { backgroundColor: T.card, borderColor: T.border }]}>
      <View style={[styles.micDot, { backgroundColor: T.emerald }]}>
        <Ionicons name="mic" size={14} color="#fff" />
      </View>
      <Small style={{ color: T.ink, flex: 1, lineHeight: 19 }}>
        Need help? Tap the green button and tell me what you want to do.
      </Small>
      <Pressable
        onPress={toggleMute}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Turn voice help on' : 'Mute voice help'}
        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
      >
        <Ionicons
          name={muted ? 'volume-mute-outline' : 'volume-high-outline'}
          size={18}
          color={T.inkMuted}
        />
      </Pressable>
    </View>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
  },
  micDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
