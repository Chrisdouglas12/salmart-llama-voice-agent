/**
 * Registration snapshot sent with the next AI turn.
 *
 * RegisterScreen reports which fields are complete and where the user is in the
 * flow. Only booleans plus two short step names travel; field values, and above
 * all the password, never leave the screen through this module.
 *
 * The module has no React Native imports so the contract can be unit-tested.
 */

let snapshot = null;

// The only string values allowed in a snapshot. Everything else must be a
// boolean, so no typed value (name, email, phone) can leave the screen.
const TEXT_KEYS = new Set(['activeField', 'stage', 'errorField', 'errorCode']);

/** Replace the pending snapshot. Only safe flags and step names are kept. */
export function reportRegistrationSnapshot(flags) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    snapshot = null;
    return;
  }
  const clean = {};
  for (const [key, value] of Object.entries(flags).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    // Reserved names: a boolean called `confirm` could be mistaken for consent,
    // and a password value must never travel. Only `confirmed` is read.
    if (key === 'password' || key === 'passwordValue' || key === 'confirm') continue;
    if (typeof value === 'boolean') clean[key] = value;
    else if (TEXT_KEYS.has(key) && typeof value === 'string' && value.length <= 40) {
      clean[key] = value;
    }
  }
  snapshot = Object.keys(clean).length ? clean : null;
}

/** Read without clearing, because the screen reports again on every change. */
export function peekRegistrationSnapshot() {
  return snapshot;
}

/** Read and clear. */
export function takeRegistrationSnapshot() {
  const value = snapshot;
  snapshot = null;
  return value;
}
