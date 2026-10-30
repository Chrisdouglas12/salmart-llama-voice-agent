import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { createThemed, useTheme } from '../../theme/theme';
import { Small, Tiny, T3 } from '../../ui/kit';

const PREVIEW_KIND = new Set(['price_change', 'message_to_seller', 'publish_listing']);

function previewLine(preview) {
  if (!preview || !PREVIEW_KIND.has(preview.kind)) return null;
  if (preview.kind === 'price_change') {
    return `New price: ₦${Number(preview.newPrice || 0).toLocaleString('en-NG')}`;
  }
  if (preview.kind === 'message_to_seller') {
    const body = String(preview.body || '').slice(0, 200);
    return body ? `Message: “${body}”` : null;
  }
  if (preview.kind === 'publish_listing') {
    return 'Publishing this listing makes it visible to buyers.';
  }
  return null;
}

export default function ConfirmationCard({ confirmation, onConfirm, onCancel }) {
  const styles = useStyles();
  const { T } = useTheme();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const handle = async (which) => {
    if (busy) return;
    setBusy(which);
    setError('');
    try {
      const fn = which === 'confirm' ? onConfirm : onCancel;
      const res = await fn?.(confirmation.actionId);
      if (res && res.ok === false) setError(res.message || 'That did not work. Please try again.');
    } catch (e) {
      setError(e?.message || 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const preview = previewLine(confirmation.preview);

  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.headRow}>
        <View style={styles.icon}>
          <Ionicons name="shield-checkmark-outline" size={16} color={T.emerald} />
        </View>
        <T3 style={styles.title}>Confirm before I continue</T3>
      </View>

      <Small style={styles.summary}>
        {confirmation.summary || 'This action needs your OK first.'}
      </Small>

      {!!preview && <Tiny style={styles.preview}>{preview}</Tiny>}
      {!!error   && <Tiny style={styles.error}>{error}</Tiny>}

      <View style={styles.actions}>
        <Pressable
          onPress={() => handle('cancel')}
          disabled={!!busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel this action"
          style={({ pressed }) => [styles.btn, styles.btnGhost, (pressed || busy === 'cancel') && { opacity: 0.7 }]}
        >
          {busy === 'cancel'
            ? <ActivityIndicator size="small" color={T.ink} />
            : <Text style={styles.btnGhostText}>Cancel</Text>}
        </Pressable>
        <Pressable
          onPress={() => handle('confirm')}
          disabled={!!busy}
          accessibilityRole="button"
          accessibilityLabel="Confirm this action"
          style={({ pressed }) => [styles.btn, styles.btnPrimary, (pressed || busy === 'confirm') && { opacity: 0.85 }]}
        >
          {busy === 'confirm'
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.btnPrimaryText}>Confirm</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  card: {
    marginTop: 8, marginBottom: 4, padding: 14,
    borderRadius: T.radius.lg,
    borderWidth: 1, borderColor: T.border, backgroundColor: T.card,
    ...T.shadow.sm,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: T.emeraldTint,
          alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: T.ink },
  summary: { marginTop: 8, color: T.ink, lineHeight: 20 },
  preview: { marginTop: 6, color: T.inkMuted, fontStyle: 'italic' },
  error:   { marginTop: 6, color: T.danger, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, minHeight: 44, borderRadius: T.radius.md,
         alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: T.emerald },
  btnPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  btnGhost: { backgroundColor: T.bgSoft, borderWidth: 1, borderColor: T.border },
  btnGhostText: { color: T.ink, fontWeight: '700', fontSize: 15 },
}));