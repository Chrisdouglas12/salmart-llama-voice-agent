import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createThemed, useTheme } from '../../theme/theme';
import { Small, Tiny, T3 } from '../../ui/kit';

/**
 * Zero-literacy product picker.
 *
 * The assistant answers a product search by opening this sheet. The buyer
 * does not need to read or pronounce a name: they touch the picture they
 * want. The parent sends the exact productId to the deterministic cart
 * route, which speaks the price and description.
 *
 * The sheet stays open after a failure the buyer can fix by touching another
 * card (sold out). A sign-in or cart error closes it and leaves the spoken
 * explanation in the chat.
 */

const money = n => (n == null ? '' : `₦${Number(n).toLocaleString('en-NG')}`);

function fingerprint(product) {
  return String(product?.productId || product?._id || product?.title || '');
}

export default function ProductPicker({ visible, products, onClose, onSelect }) {
  const { T } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [pickingId, setPickingId] = useState(null);
  const [error, setError] = useState('');

  const list = useMemo(
    () => (Array.isArray(products) ? products.filter(Boolean) : []),
    [products],
  );

  // A new search resets the in-sheet status.
  useEffect(() => {
    if (visible) {
      setPickingId(null);
      setError('');
    }
  }, [visible, list.length]);

  const pick = useCallback(async (product) => {
    if (pickingId) return;
    const id = fingerprint(product);
    setPickingId(id);
    setError('');
    try {
      const result = await onSelect?.(product);
      if (result?.ok) {
        onClose?.();
      } else if (result?.code === 'UNAVAILABLE') {
        // Sold out: keep the sheet open so the buyer can touch another one.
        setError(result.message || 'That one is not available. Touch another one.');
      } else {
        onClose?.();
      }
    } catch (_e) {
      setError('That one could not be added. Touch another one.');
    } finally {
      setPickingId(null);
    }
  }, [onSelect, onClose, pickingId]);

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable
          style={styles.backdropFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the product picker"
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <T3 style={{ color: T.ink, fontWeight: '800' }}>Touch the one you want</T3>
              <Small style={{ color: T.inkMuted, marginTop: 3, lineHeight: 18 }}>
                You do not need to read or say its name. Just touch the picture.
              </Small>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [styles.close, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name="close" size={20} color={T.ink} />
            </Pressable>
          </View>

          {!!error && (
            <View style={[styles.error, { borderColor: T.dangerBorder, backgroundColor: T.dangerSoft }]}>
              <Small style={{ color: T.danger, fontWeight: '700' }}>{error}</Small>
            </View>
          )}

          <ScrollView
            contentContainerStyle={styles.grid}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {list.map((p, i) => {
              const id = fingerprint(p) || String(i);
              const busy = pickingId === id;
              const photo = p.photo || (Array.isArray(p.photos) ? p.photos[0] : null);
              return (
                <Pressable
                  key={id}
                  onPress={() => pick(p)}
                  disabled={!!pickingId}
                  accessibilityRole="button"
                  accessibilityLabel={p.title || 'Product'}
                  accessibilityHint="Adds this item to your cart"
                  style={({ pressed }) => [
                    styles.card,
                    { borderColor: T.border, backgroundColor: T.card },
                    pressed && { opacity: 0.9 },
                    busy && { opacity: 0.75 },
                  ]}
                >
                  <View style={[styles.thumb, { backgroundColor: T.bgSoft }]}>
                    {photo ? (
                      <Image source={{ uri: photo }} style={styles.img} contentFit="cover" />
                    ) : (
                      <Ionicons name="cube-outline" size={30} color={T.muted} />
                    )}
                    {busy && (
                      <View style={styles.busy}>
                        <ActivityIndicator color="#fff" />
                      </View>
                    )}
                  </View>
                  <View style={styles.body}>
                    <T3 numberOfLines={2} style={{ color: T.ink, lineHeight: 19 }}>
                      {p.title || 'Listing'}
                    </T3>
                    <Small style={{ color: T.emerald, fontWeight: '800', marginTop: 4, fontSize: 16 }}>
                      {money(p.price)}
                    </Small>
                    {!!p.sellerName && (
                      <Tiny numberOfLines={1} style={{ color: T.muted, marginTop: 2 }}>
                        {p.sellerName}
                      </Tiny>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  backdropFill: { ...StyleSheet.absoluteFillObject },
  sheet: {
    maxHeight: '84%',
    backgroundColor: T.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 8,
    ...T.shadow.lg,
  },
  handle: {
    alignSelf: 'center', width: 42, height: 4, borderRadius: 2,
    backgroundColor: T.border, marginBottom: 10,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  close: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', backgroundColor: T.bgSoft,
  },
  error: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'space-between', gap: 12, paddingBottom: 8,
  },
  card: {
    width: '48%', borderRadius: T.radius.lg,
    borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
    ...T.shadow.sm,
  },
  thumb: { height: 132, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  busy: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  body: { padding: 10 },
}));
