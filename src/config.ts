// Google OAuth "Web application" client ID, used for "Sign in with Google".
// Create one at https://console.cloud.google.com/apis/credentials →
// "Create credentials" → "OAuth client ID" → Application type: Web application,
// and add your site URL (e.g. https://aitranslatevideo.freebuff.app) under
// "Authorized JavaScript origins". Then paste the client ID below or set
// VITE_GOOGLE_CLIENT_ID in your environment.
const HARDCODED_CLIENT_ID =
  '892990738737-3hb94nkf16qn304qcjdsb91pppg03rvm.apps.googleusercontent.com';

export const GOOGLE_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || HARDCODED_CLIENT_ID;