/**
 * urlState.js — the address bar is the source of truth for what the app shows.
 *
 * Every view worth linking to keeps its state in the hash, as a route plus query
 * parameters: `#outputs?experiment=baseline-gemini_FINAL&subject=math`. A hash
 * rather than a path because the production build is static — the server only
 * ever serves index.html, and a fragment never reaches it, so deep links survive
 * a hard reload with no rewrite rules. That is also what already lets the
 * human-eval and single-output pages open in their own browser tab.
 *
 * Navigations (opening a figure, switching tabs) push a history entry; filters
 * and canonicalised defaults replace it. Back therefore steps between views
 * instead of unwinding one checkbox at a time.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** '#outputs?subject=math' -> { route: 'outputs', params: URLSearchParams } */
export function parseHash(hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const q = raw.indexOf('?')
  return {
    route: q >= 0 ? raw.slice(0, q) : raw,
    params: new URLSearchParams(q >= 0 ? raw.slice(q + 1) : ''),
  }
}

/** route + params -> the '#…' to put in the address bar. */
function buildHash(route, params) {
  const qs = params.toString()
  return qs ? `#${route}?${qs}` : `#${route}`
}

// pushState and replaceState deliberately do not fire hashchange, so anything
// written through navigate() has to notify subscribers by hand.
const listeners = new Set()

function subscribe(onChange) {
  listeners.add(onChange)
  window.addEventListener('hashchange', onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener('popstate', onChange)
  }
}

const readHash = () => window.location.hash

/**
 * Point the app at a route.
 * @param {URLSearchParams} params
 * @param {boolean} [opts.replace] true for state the user did not navigate to —
 *   a filter, or a default written back to canonicalise the URL — so it does not
 *   become a stop on the way back.
 */
export function navigate(route, params, { replace = false } = {}) {
  const hash = buildHash(route, params)
  if (hash === window.location.hash) return
  const url = window.location.pathname + window.location.search + hash
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  for (const notify of listeners) notify()
}

/** The current route and query params, re-rendering when either changes. */
export function useHashRoute() {
  const hash = useSyncExternalStore(subscribe, readHash, () => '')
  return useMemo(() => parseHash(hash), [hash])
}

/**
 * Route, params, and a writer that merges a patch into the query string.
 *
 * Keys set to null, undefined, or '' are removed, so a filter sitting at its
 * default leaves the URL clean instead of accumulating `subject=all`.
 */
export function useUrlState() {
  const { route, params } = useHashRoute()

  const setParams = useCallback((patch, opts) => {
    // Re-read the live hash rather than closing over `params`: two setParams
    // calls in one event handler both have to land.
    const current = parseHash(window.location.hash)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') current.params.delete(key)
      else current.params.set(key, String(value))
    }
    navigate(current.route, current.params, opts)
  }, [])

  return { route, params, setParams }
}
