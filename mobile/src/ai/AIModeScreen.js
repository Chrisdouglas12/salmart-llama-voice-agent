import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet,
  TextInput, View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { createThemed, useTheme } from '../theme/theme';
import { useNav } from '../state/Navigation';
import { useAI } from './AIContext';
import { IconButton, Small, Tiny, T2, T3, Body } from '../ui/kit';
import MessageBubble from './components/MessageBubble';

/**
 * The AI Mode conversation screen. Text-only in cycle 1 — voice returns in a
 * later cycle via expo-speech-recognition, which needs no backend round-trip.
 *
 * Structured blocks that arrive as `fill_ad` / `fill_request` / `fill_profile`
 * are consumed by the corresponding form screen via useAIPatch, not rendered
 * here (the StructuredBlock allowlist omits them, so they render nothing).
 */

const SUGGESTIONS = [
  { key: 'find', label: 'Find a product', text: 'Find me a blender under ₦20,000' },
  { key: 'sell', label: 'Help me start selling', text: 'I want to sell something' },
  { key: 'use', label: 'How to use Salmart', text: 'How do I use this app?' },
  { key: 'orders', label: 'Check my orders', text: 'Where is my order?' },
];

export default function AIModeScreen({ route }) {
  const { T } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const {
    messages, status, send, confirm, cancel, reset, isReady,
    recording, transcribing, toggleRecording, startGoogleAuth, speak, openSellerChat,
  } = useAI();

  const [draft, setDraft] = useState('');
  const listRef = useRef(null);

  // Screen context: if the user came from a form screen, let the model know.
  // Only primitives are sent — nothing else, per the backend contract. The
  // platform is always included so the Google URL can be built without asking.
  // chatPartnerId lets "what did the seller say?" resolve to this thread.
  const screenHint = route?.params?.screen || null;
  const chatPartnerHint = route?.params?.chatPartnerId || null;
  const turnContext = useMemo(() => ({
    platform: Platform.OS,
    ...(screenHint ? { screen: screenHint } : {}),
    ...(chatPartnerHint ? { chatPartnerId: String(chatPartnerHint).slice(0, 24) } : {}),
  }), [screenHint, chatPartnerHint]);

  const sending = status === 'sending';
  const canSend = draft.trim().length > 0 && !sending;

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  useEffect(() => {
    if (messages.length) scrollToEnd();
  }, [messages.length, scrollToEnd]);

  const onSend = useCallback(async (text) => {
    const clean = String(text ?? draft).trim();
    if (!clean || sending) return;
    setDraft('');
    await send(clean, turnContext);
  }, [draft, sending, send, turnContext]);

  const onSuggestion = useCallback((s) => onSend(s.text), [onSend]);

  const onOpenAuth = useCallback(async (block) => {
    if (!block?.url) return;
    await startGoogleAuth({ url: block.url, platform: block.platform });
  }, [startGoogleAuth]);

  const onSpeak = useCallback((text) => { speak(text); }, [speak]);

  const onOpenProduct = useCallback((product) => {
    if (!product?.productId && !product?._id) return;
    const postId = product.productId || product._id;
    nav.push('checkout', {
      postId,
      listing: {
        _id: postId,
        title: product.title,
        price: product.price,
        photo: product.photo,
        postType: 'regular',
      },
      productType: 'regular',
    });
  }, [nav]);

  const onPickMethod = useCallback((methodId) => {
    if (methodId === 'google') {
      // Sending a message triggers the model to call startGoogleAuthentication
      // and return the URL; the app's existing SignInScreen handles the actual
      // flow when the user leaves AI Mode. This is just a convenience hook.
      onSend('Continue with Google');
      return;
    }
    if (methodId === 'email') {
      nav.push('register');
    }
  }, [onSend, nav]);

  const header = useMemo(() => (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <IconButton
        icon="chevron-back"
        onPress={() => nav.goBack()}
        bg={T.bgSoft}
        size={22}
      />
      <View style={styles.headerAvatar}>
        <Ionicons name="sparkles" size={16} color="#fff" />
      </View>
      <View style={{ flex: 1, marginLeft: 10 }}>
        <T2 numberOfLines={1}>Salmart AI</T2>
        <Tiny numberOfLines={1} style={{ color: sending ? T.emerald : T.inkMuted, marginTop: 1 }}>
          {sending ? 'Thinking…' : 'Ready to help'}
        </Tiny>
      </View>
      {messages.length > 0 && (
        <IconButton
          icon="refresh-outline"
          onPress={reset}
          bg={T.bgSoft}
          size={18}
        />
      )}
    </View>
  ), [T, insets.top, sending, messages.length, reset, nav, styles]);

  const welcome = (
    <View style={styles.welcome}>
      <View style={styles.welcomeAvatar}>
        <Ionicons name="sparkles" size={26} color="#fff" />
      </View>
      <T2 style={styles.welcomeTitle}>Hi! I'm Salmart AI.</T2>
      <Body style={styles.welcomeSub}>
        Tell me what you want to do. I'll help you get it done.
      </Body>
      <View style={styles.chipGrid}>
        {SUGGESTIONS.map(s => (
          <Pressable
            key={s.key}
            onPress={() => onSuggestion(s)}
            accessibilityRole="button"
            accessibilityLabel={s.label}
            style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
          >
            <Small style={styles.chipText}>{s.label}</Small>
            <Ionicons name="arrow-forward" size={14} color={T.emerald} />
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      {header}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item, i) => item?.key || `m-${i}`}
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              onConfirm={confirm}
              onCancel={cancel}
              onOpenProduct={onOpenProduct}
              onPickMethod={onPickMethod}
              onOpenAuth={onOpenAuth}
              onSpeak={onSpeak}
              onOpenChat={openSellerChat}
            />
          )}
          ListHeaderComponent={messages.length === 0 ? welcome : <View style={{ height: 4 }} />}
          contentContainerStyle={[styles.listContent, { paddingBottom: 8 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={9}
        />

        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) + 6 }]}>
          <View style={styles.inputWrap}>
            <Pressable
              onPress={() => toggleRecording(turnContext)}
              disabled={transcribing || sending}
              accessibilityRole="button"
              accessibilityLabel={recording ? 'Stop recording' : 'Talk to Salmart AI'}
              accessibilityState={{ busy: transcribing, disabled: transcribing || sending }}
              style={({ pressed }) => [
                styles.micBtn,
                recording && { backgroundColor: T.danger, borderColor: T.danger },
                (transcribing || sending) && { opacity: 0.5 },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Ionicons
                name={recording ? 'stop' : transcribing ? 'hourglass-outline' : 'mic'}
                size={20}
                color={recording ? '#fff' : T.emerald}
              />
            </Pressable>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={sending ? 'Thinking…' : 'Ask me anything…'}
              placeholderTextColor={T.muted}
              multiline
              maxLength={2000}
              editable={!sending}
              style={styles.input}
              onSubmitEditing={() => onSend()}
              blurOnSubmit={false}
              accessibilityLabel="Message Salmart AI"
            />
            <Pressable
              onPress={() => onSend()}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend, busy: sending }}
              style={({ pressed }) => [
                styles.sendBtn,
                !canSend && { opacity: 0.4 },
                pressed && canSend && { opacity: 0.85 },
              ]}
            >
              <Ionicons name={sending ? 'ellipsis-horizontal' : 'arrow-up'} size={20} color="#fff" />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingBottom: 10,
    backgroundColor: T.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.border,
  },
  headerAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: T.emerald,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 4,
  },

  listContent: { paddingHorizontal: T.space.lg, paddingTop: 8, paddingBottom: 12, flexGrow: 1 },

  welcome: {
    alignItems: 'center', paddingTop: T.space.xl * 2, paddingBottom: T.space.xl,
  },
  welcomeAvatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: T.emerald,
    alignItems: 'center', justifyContent: 'center',
    ...T.shadow.brand,
    marginBottom: T.space.md,
  },
  welcomeTitle: {
    color: T.ink, textAlign: 'center', fontWeight: '800',
  },
  welcomeSub: {
    color: T.inkMuted, textAlign: 'center', marginTop: 8,
    paddingHorizontal: 24, lineHeight: 21,
  },
  chipGrid: {
    alignSelf: 'stretch', marginTop: T.space.xl,
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 11,
    borderRadius: T.radius.pill,
    backgroundColor: T.card,
    borderWidth: 1, borderColor: T.border,
    ...T.shadow.sm,
  },
  chipText: { color: T.ink, fontWeight: '700' },

  composer: {
    paddingHorizontal: T.space.md, paddingTop: 8,
    backgroundColor: T.card,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border,
  },
  inputWrap: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    backgroundColor: T.bgSoft,
    borderRadius: 22, borderWidth: 1, borderColor: T.border,
    paddingLeft: 6, paddingRight: 6, paddingVertical: 6,
  },
  micBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.border,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    flex: 1, minHeight: 36, maxHeight: 120,
    fontSize: 15, lineHeight: 20, color: T.ink,
    paddingTop: 8, paddingBottom: 8,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
}));