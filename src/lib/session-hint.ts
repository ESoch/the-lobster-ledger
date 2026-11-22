/**
 * The server answers a visitor who never signed in and one whose session ran out with the same 401.
 * This browser-side note is the only way to tell them apart: it is set after a successful sign-in and
 * cleared when the member signs out on purpose. It holds no personal data, and the page works
 * the same when storage is unavailable.
 */
const SESSION_HINT = 'lobster-ledger-had-session';

export function rememberSession() {
  try {
    window.localStorage.setItem(SESSION_HINT, '1');
  } catch {
    // Without it the visitor just sees the ordinary welcome.
  }
}

export function forgetSession() {
  try {
    window.localStorage.removeItem(SESSION_HINT);
  } catch {
    // Nothing was stored, or nothing can be.
  }
}

export function hadSession(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT) === '1';
  } catch {
    return false;
  }
}
