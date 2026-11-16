import { type RefObject, useEffect, useState } from 'react';

/** Whether this browser can draw the 3D view: three.js needs WebGL2 (architecture §11). */
export function hasWebGL2(): boolean {
  if (typeof WebGL2RenderingContext === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The system's reduced-motion setting, followed as it changes (NFR-10). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(REDUCED_MOTION);
    const changed = () => setReduced(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return reduced;
}

/** Whether the tab is hidden (another tab in front, the window minimised). */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const changed = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return hidden;
}

/** Whether the element is scrolled out of view (always false where IntersectionObserver is missing). */
export function useOffscreen(ref: RefObject<Element | null>): boolean {
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setOffscreen(!last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return offscreen;
}

/** A choice remembered in this browser (the view and the quality); the default when storage fails. */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {
      // Private mode or blocked storage: the choice lasts until the page is left.
    }
  };
  return [value, set];
}
