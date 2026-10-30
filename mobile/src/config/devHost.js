/**
 * Dev API host resolution (no hardcoded IPs).
 *
 * When the app is loaded from Metro, the dev server already knows which
 * machine is serving the bundle. In local testing that same machine also runs
 * the backend on port 3000, so the API origin can be derived instead of
 * baking a LAN IP into the build. That survives DHCP changes and the
 * difference between phone / emulator / hotspot.
 *
 * Deliberately conservative:
 *   - only private IPv4 (RFC1918) or loopback hosts are trusted;
 *   - tunnel/public hostnames (e.g. `*.exp.direct`) are ignored, because
 *     Metro being reachable through a tunnel says nothing about the backend;
 *   - an explicit EXPO_PUBLIC_API_URL always wins (see config.js).
 *
 * Pure function, no imports, so it can be reasoned about and tested alone.
 */

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/**
 * @param {string} hostUri   Metro host, e.g. "192.168.0.101:8081" or "localhost:8081"
 * @param {string} platform  "android" | "ios" | "web"
 * @param {number} [port]    backend port (default 3000)
 * @returns {string} API origin, or '' when the host is not a safe LAN host
 */
export function apiBaseFromMetroHost(hostUri, platform, port = 3000) {
  const raw = String(hostUri || '').trim();
  if (!raw) return '';

  // Accept "192.168.0.101:8081", "exp://192.168.0.101:8081", "[::1]:8081",
  // "http://host:8081/anything".
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const hostPart = withoutScheme.split('/')[0];
  const bracketed = hostPart.match(/^\[([^\]]+)\](?::\d+)?$/);
  const host = bracketed ? bracketed[1] : hostPart.replace(/:\d+$/, '');

  const apiPort = Number(port) > 0 ? Number(port) : 3000;

  // Loopback: on a physical phone this would be the phone itself, so map the
  // Android emulator alias and leave everything else to 127.0.0.1.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return platform === 'android' ? `http://10.0.2.2:${apiPort}` : `http://127.0.0.1:${apiPort}`;
  }

  if (!PRIVATE_V4.test(host)) return '';
  return `http://${host}:${apiPort}`;
}

export default apiBaseFromMetroHost;
