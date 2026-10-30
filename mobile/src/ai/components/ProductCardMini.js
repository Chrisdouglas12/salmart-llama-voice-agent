import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { createThemed, useTheme } from '../../theme/theme';
import { Tiny, Small, T3 } from '../../ui/kit';

const money = n => (n == null ? '' : `₦${Number(n).toLocaleString('en-NG')}`);

export default function ProductCardMini({ product, onPress }) {
  const styles = useStyles();
  const { T } = useTheme();
  if (!product) return null;

  const photo = product.photo || (product.photos && product.photos[0]) || null;

  return (
    <Pressable
      onPress={() => onPress?.(product)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
      accessibilityRole="button"
      accessibilityLabel={product.title || 'Product'}
    >
      <View style={styles.thumb}>
        {photo ? (
          <Image source={{ uri: photo }} style={styles.img} contentFit="cover" />
        ) : (
          <View style={styles.placeholder}>
            <Ionicons name="cube-outline" size={22} color={T.muted} />
          </View>
        )}
      </View>
      <View style={styles.body}>
        <T3 numberOfLines={2} style={styles.title}>{product.title || 'Listing'}</T3>
        <Small style={styles.price}>{money(product.price)}</Small>
        <View style={styles.metaRow}>
          {!!product.location && (
            <>
              <Ionicons name="location-outline" size={11} color={T.muted} />
              <Tiny numberOfLines={1} style={styles.metaText}>{product.location}</Tiny>
            </>
          )}
          {!!product.sellerName && (
            <Tiny numberOfLines={1} style={[styles.metaText, { marginLeft: 'auto' }]}>
              {product.sellerName}
            </Tiny>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const useStyles = createThemed(({ T }) => StyleSheet.create({
  card: {
    width: 180,
    borderRadius: T.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.border,
    backgroundColor: T.card,
    overflow: 'hidden',
    ...T.shadow.sm,
  },
  thumb: { height: 120, backgroundColor: T.bgSoft },
  img: { width: '100%', height: '100%' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 10, gap: 4 },
  title: { color: T.ink, fontSize: 14, lineHeight: 18 },
  price: { color: T.emerald, fontWeight: '800' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: { color: T.muted },
}));