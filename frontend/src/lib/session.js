// Who is signed in. One /api/auth/me request is shared by every component that asks.
//
//   const { status, user } = useSession();   // status: 'loading' | 'signed_in' | 'signed_out'
//   signIn();                                  // GitHub sign-in, then back to this page
//   await signOutAndForget();
import { useEffect, useSyncExternalStore } from 'react';
import { fetchMe, signInUrl, signOut } from '../api';

let state = { status: 'loading', user: null };
let pending = null;
const listeners = new Set();

function setState(next) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads the session once (or again with force). Network failures count as signed out. */
export function loadSession({ force = false } = {}) {
  if (pending && !force) return pending;
  pending = fetchMe()
    .then((user) => setState(user ? { status: 'signed_in', user } : { status: 'signed_out', user: null }))
    .catch(() => setState({ status: 'signed_out', user: null }));
  return pending;
}

export function useSession() {
  useEffect(() => {
    loadSession();
  }, []);
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Current path (+ query), the default place to come back to after signing in. */
export function currentPath() {
  return `${window.location.pathname}${window.location.search}`;
}

export function signIn(next = currentPath()) {
  window.location.assign(signInUrl(next));
}

export async function signOutAndForget() {
  try {
    await signOut();
  } finally {
    setState({ status: 'signed_out', user: null });
  }
}

/** Test helper. */
export function __setSession(next) {
  pending = Promise.resolve();
  setState(next);
}
