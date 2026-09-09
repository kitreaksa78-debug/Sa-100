// Google Identity Services (GIS) helper for "Sign in with Google".
// Docs: https://developers.google.com/identity/gsi/web

export interface GoogleUser {
  sub: string;
  name: string;
  email: string;
  picture?: string;
}

const STORAGE_KEY = 'fb_google_user';

let scriptPromise: Promise<boolean> | null = null;

/** Load the Google Identity Services client script (idempotent). */
export function loadGoogleScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Decode the JWT payload Google returns in the credential response. */
export function decodeJwtCredential(token: string): Record<string, any> | null {
  try {
    const part = token.split('.')[1] || '';
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(normalized))));
  } catch {
    return null;
  }
}

/** Initialize the GIS client and render the official Google button. */
export function renderGoogleButton(
  container: HTMLElement,
  clientId: string,
  onCredential: (user: GoogleUser) => void,
) {
  if (typeof window === 'undefined' || !window.google?.accounts?.id) return;
  window.google.accounts.id.initialize({
    client_id: clientId,
    auto_select: false,
    callback: (resp: { credential?: string }) => {
      const payload = decodeJwtCredential(resp?.credential || '');
      if (!payload?.sub) return;
      onCredential({
        sub: payload.sub,
        name: payload.name || '',
        email: payload.email || '',
        picture: payload.picture,
      });
    },
  });
  window.google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
    width: 320,
  });
}

export function saveUser(user: GoogleUser) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function loadUser(): GoogleUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.sub ? (parsed as GoogleUser) : null;
  } catch {
    return null;
  }
}

export function clearUser() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    /* ignore */
  }
}

// Per-account storage: every account's data is kept under its own key so
// signing out and signing in with a different Google account never leaks
// another account's settings/usage. Guests (no account) use the legacy keys.

export function groqKeyStorageKey(sub?: string): string {
  return sub ? `groq_api_key:${sub}` : 'groq_api_key';
}

export function loadGroqKey(sub?: string): string {
  try {
    return localStorage.getItem(groqKeyStorageKey(sub)) || '';
  } catch {
    return '';
  }
}

export function saveGroqKey(sub: string | undefined, key: string): void {
  try {
    const storageKey = groqKeyStorageKey(sub);
    if (key) localStorage.setItem(storageKey, key);
    else localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}