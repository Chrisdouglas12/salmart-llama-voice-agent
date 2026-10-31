import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme/theme';
import ProductCardMini from './ProductCardMini';
import { Small, Tiny, T3 } from '../../ui/kit';

/**
 * Renders the supported structured blocks returned by the assistant.
 *
 * The renderer map is also an allowlist: unknown types render nothing, so a
 * changed or compromised backend cannot mount an unexpected component.
 *
 * fill_ad, fill_request and fill_profile are handled by their form screens
 * through useAIPatch and are deliberately absent here.
 */

function Unknown() { return null; }

function ProductResults({ block, onOpenProduct }) {
  const { T } = useTheme();
  const products = Array.isArray(block.products) ? block.products : [];
  if (!products.length) return null;
  return (
    <View style={styles.wrap}>
      <Tiny style={{ color: T.inkMuted, marginBottom: 6 }}>
        {block.total > 1 ? `${block.total} results · swipe for more` : '1 result'}
      </Tiny>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {products.map((p, i) => (
          <ProductCardMini key={`${p.productId || i}`} product={p} onPress={onOpenProduct} />
        ))}
      </ScrollView>
    </View>
  );
}

function ProductDetails({ block, onOpenProduct }) {
  const { T } = useTheme();
  const p = block.product;
  if (!p) return null;
  return (
    <View style={styles.wrap}>
      <T3 numberOfLines={2} style={{ color: T.ink }}>{p.title || 'Listing'}</T3>
      <Small style={{ color: T.emerald, fontWeight: '800', marginTop: 4 }}>
        ₦{Number(p.price || 0).toLocaleString('en-NG')}
      </Small>
      {!!p.description && (
        <Small numberOfLines={4} style={{ color: T.ink, marginTop: 6, lineHeight: 20 }}>
          {p.description}
        </Small>
      )}
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <ProductCardMini
          product={{ ...p, photo: (p.photos && p.photos[0]) || null }}
          onPress={onOpenProduct}
        />
      </View>
    </View>
  );
}

function ListingList({ block, onOpenProduct }) {
  const { T } = useTheme();
  const listings = Array.isArray(block.listings) ? block.listings : [];
  if (!listings.length) return null;
  return (
    <View style={styles.wrap}>
      <Tiny style={{ color: T.inkMuted, marginBottom: 6 }}>Your listings</Tiny>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {listings.map((l, i) => (
          <ProductCardMini key={`${l.productId || i}`} product={l} onPress={onOpenProduct} />
        ))}
      </ScrollView>
    </View>
  );
}

function OrderInformation({ block }) {
  const { T } = useTheme();
  const orders = Array.isArray(block.orders)
    ? block.orders
    : (block.order ? [block.order] : []);
  if (!orders.length) return null;
  return (
    <View style={styles.wrap}>
      {orders.map((o, i) => (
        <View key={`${o.transactionId || i}`} style={[styles.row, i > 0 && { marginTop: 8 }]}>
          <T3 numberOfLines={1} style={{ color: T.ink, flex: 1 }}>{o.title || 'Order'}</T3>
          <Tiny style={{ color: T.inkMuted }}>{o.statusLabel || o.status}</Tiny>
        </View>
      ))}
    </View>
  );
}

function OnboardingOptions({ block, onPickMethod }) {
  const { T } = useTheme();
  const methods = Array.isArray(block.methods) ? block.methods : [];
  if (!methods.length) return null;
  return (
    <View style={styles.wrap}>
      {methods.map(m => (
        <View key={m.id} style={[styles.option, { borderColor: T.border }]}>
          <T3 style={{ color: T.ink }}>{m.label}</T3>
          {!!m.description && (
            <Small style={{ color: T.inkMuted, marginTop: 2 }}>{m.description}</Small>
          )}
          <View style={{ marginTop: 10 }}>
            <Small
              onPress={() => onPickMethod?.(m.id)}
              accessibilityRole="button"
              style={{ color: T.emerald, fontWeight: '800' }}
            >
              Choose this
            </Small>
          </View>
        </View>
      ))}
    </View>
  );
}

function MessagePreview({ block, onOpenChat }) {
  const { T } = useTheme();
  const p = block.prepared;
  if (!p) return null;
  const handoff = {
    sellerId: p.sellerId,
    sellerName: p.sellerName,
    productId: p.productId,
    productTitle: p.productTitle,
    imageUrl: p.productImageUrl || null,
    price: p.productPrice ?? null,
    draft: p.body,
  };
  return (
    <ChatHandoff block={handoff} onOpenChat={onOpenChat} />
  );
}

/**
 * Seller-chat handoff. Shows the draft and product photo as information only.
 * The app already opens the chat with the draft pre-filled, so there is no
 * button here; the user sends with the green arrow at the bottom of the chat
 * screen. Nothing is sent from this component.
 */
function ChatHandoff({ block }) {
  const { T } = useTheme();
  if (!block || !block.sellerId) return null;
  return (
    <View style={styles.wrap}>
      {!!block.imageUrl && (
        <Image
          source={{ uri: String(block.imageUrl) }}
          style={{ width: '100%', height: 140, borderRadius: 12, marginBottom: 8 }}
          resizeMode="cover"
        />
      )}
      <Tiny style={{ color: T.inkMuted }}>
        Message to {block.sellerName || 'the seller'}{block.productTitle ? ` · ${block.productTitle}` : ''}
      </Tiny>
      {!!block.draft && (
        <Small style={{ color: T.ink, marginTop: 4, lineHeight: 20 }}>{block.draft}</Small>
      )}
    </View>
  );
}

function Capabilities({ block }) {
  const { T } = useTheme();
  const caps = Array.isArray(block.capabilities) ? block.capabilities : [];
  if (!caps.length) return null;
  return (
    <View style={styles.wrap}>
      {caps.map(c => (
        <Small key={c.name} style={{ color: T.ink, marginBottom: 4 }}>• {c.description}</Small>
      ))}
    </View>
  );
}

/**
 * Google sign-in handoff. The URL has already been checked by the backend and
 * by StructuredBlock's caller; this component only decides how it looks. It
 * does not open automatically, so a misheard phrase cannot launch a browser.
 */
function AuthHandoff({ block, onOpenAuth, onSpeak }) {
  const { T } = useTheme();
  if (block.authMethod !== 'google' || !block.url) return null;
  const label = 'Continue with Google';
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onOpenAuth?.(block)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.option,
          styles.actionRow,
          { borderColor: T.border, backgroundColor: T.card },
          pressed && { opacity: 0.75 },
        ]}
      >
        <Ionicons name="logo-google" size={16} color={T.ink} />
        <Small style={{ color: T.ink, fontWeight: '800', marginLeft: 8 }}>{label}</Small>
      </Pressable>
      {!!onSpeak && (
        <Small
          onPress={() => onSpeak('Tap continue with Google. Your phone will show a list of Google accounts.')}
          accessibilityRole="button"
          accessibilityLabel="Hear what to do"
          style={{ color: T.emerald, fontWeight: '800', marginTop: 8 }}
        >
          Hear what to do
        </Small>
      )}
    </View>
  );
}

/**
 * Registration prefill confirmation. useAIPatch has already applied the fields
 * to the register form; this explains what the user still has to do by hand
 * (password, terms, email verification) and can be read aloud.
 */
function RegistrationFill({ block, onSpeak }) {
  const { T } = useTheme();
  const note = block.note
    || 'Your name and email are filled in. Choose a password yourself, accept the terms, then create the account.';
  return (
    <View style={styles.wrap}>
      <Small style={{ color: T.ink, lineHeight: 20 }}>{note}</Small>
      {!!onSpeak && (
        <Small
          onPress={() => onSpeak(note)}
          accessibilityRole="button"
          accessibilityLabel="Hear this again"
          style={{ color: T.emerald, fontWeight: '800', marginTop: 8 }}
        >
          Hear this again
        </Small>
      )}
    </View>
  );
}

const RENDERERS = Object.freeze({
  product_results:    ProductResults,
  product_details:    ProductDetails,
  listing_list:       ListingList,
  order_information:  OrderInformation,
  order_details:      OrderInformation,
  onboarding_options: OnboardingOptions,
  message_preview:    MessagePreview,
  chat_handoff:       ChatHandoff,
  capabilities:       Capabilities,
  auth_url:           AuthHandoff,
  fill_register:      RegistrationFill,
  // The other fill_* types belong to their form screens.
});

export default function StructuredBlock({
  block, onOpenProduct, onPickMethod, onOpenAuth, onSpeak, onOpenChat,
}) {
  if (!block || typeof block !== 'object') return null;
  const R = RENDERERS[block.type];
  if (!R) return <Unknown />;
  return (
    <R
      block={block}
      onOpenProduct={onOpenProduct}
      onPickMethod={onPickMethod}
      onOpenAuth={onOpenAuth}
      onSpeak={onSpeak}
      onOpenChat={onOpenChat}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8, marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 0 },
  option: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: 8,
  },
});