/**
 * Form snapshot sent with the next AI turn.
 *
 * CreateAdScreen reports presence and validity flags (booleans plus postType).
 * Price and quantity are also included because the assistant uses them to
 * tailor the discount offer. No other field values leave the screen, and the
 * backend uses the snapshot as context only.
 *
 * The module has no React Native imports so the contract can be unit-tested.
 */

let snapshot = null;

/** Replace the pending snapshot. Only flags, postType, price and quantity are kept. */
export function reportFormSnapshot(flags) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    snapshot = null;
    return;
  }
  const clean = {};
  for (const [key, value] of Object.entries(flags).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === 'boolean') clean[key] = value;
    // Price and quantity are needed for the discount offer. No free text is
    // ever included.
    if ((key === 'price' || key === 'quantity') && typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    }
  }
  if (typeof flags.postType === 'string' && flags.postType.length <= 20) {
    clean.postType = flags.postType;
  }
  snapshot = Object.keys(clean).length ? clean : null;
}

/** Read without clearing, because the form reports again on every change. */
export function peekFormSnapshot() {
  return snapshot;
}

/** Read and clear. */
export function takeFormSnapshot() {
  const value = snapshot;
  snapshot = null;
  return value;
}
