import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { createThemed, useTheme } from '../../theme/theme';
import { Small, Tiny } from '../../ui/kit';

import ConfirmationCard from './ConfirmationCard';
import StructuredBlock from './StructuredBlock';

export default function MessageBubble({
  message, onConfirm, onCancel, onOpenProduct, onPickMethod, onOpenAuth, onSpeak, onOpenChat,
}) {
  const styles = useStyles();
  const { T } = useTheme();

  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Small style={styles.userText}>{message.text}</Small>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantCol}>
        <View style={styles.botAvatar}>
          <Ionicons name="sparkles" size={12} color="#fff" />
        </View>
        <View style={styles.assistantBody}>
          {!!message.text && (
            <View style={[styles.botBubble, message.kind === 'error' && styles.botBubbleError]}>
              <Small style={[styles.botText, message.kind === 'error' && { color: T.danger, fontWeight: '600' }]}>
                {message.text}
              </Small>
            </View>
          )}

          {Array.isArray(message.structured) && message.structured.length > 0 && (
            <View style={styles.structuredWrap}>
              {message.structured.map((block, i) => (
                <StructuredBlock
                  key={`${block.type || 'block'}-${i}`}
                  block={block}
                  onOpenProduct={onOpenProduct}
                  onPickMethod={onPickMethod}
                  onOpenAuth={onOpenAuth}
                  onSpeak={onSpeak}
                  onOpenChat={onOpenChat}
                />
              ))}
            </View>
          )}

          {!!message.confirmation && (
            <ConfirmationCard
              confirmation={message.confirmation}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}

          {!!message.at && (
            <Tiny style={styles.time}>
              {new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Tiny>
          )}
        </View>
      </View>
    </View>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  userRow: { alignItems: 'flex-end', marginBottom: 12 },
  userBubble: {
    maxWidth: '84%',
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: T.emerald, borderRadius: 18, borderTopRightRadius: 6,
    ...T.shadow.sm,
  },
  userText: { color: '#fff', lineHeight: 20 },

  assistantRow: { marginBottom: 14 },
  assistantCol: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  botAvatar: {
    width: 22, height: 22, borderRadius: 11, marginTop: 2,
    backgroundColor: T.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  assistantBody: { flex: 1, minWidth: 0 },
  botBubble: {
    maxWidth: '100%',
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: T.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.border,
    borderRadius: 18, borderTopLeftRadius: 6,
    ...T.shadow.sm,
  },
  botBubbleError: {
    borderColor: T.dangerBorder,
    backgroundColor: T.dangerSoft,
  },
  botText: { color: T.ink, lineHeight: 20 },
  structuredWrap: { marginTop: 6 },
  time: { color: T.muted, marginTop: 4, fontSize: 10.5 },
}));