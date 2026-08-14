// Hold a value steady for `delay` ms after its last change, then release it.
//
// Used together with useDeferredValue in the typing hot path (Outline,
// annotations) so a fast typist in a large document doesn't re-parse the whole
// note on every keystroke: the debounce collapses a typing burst into one
// delayed update, and useDeferredValue then runs the (now rare) recompute at a
// non-blocking priority. Final consistency is preserved — it always catches up
// once the user pauses.

import { useEffect, useRef, useState } from "react";

/** Returns a copy of `value` that only updates after it has been stable for
 *  `delay` ms. The initial render returns `value` immediately (no leading
 *  delay) so the first paint isn't blank. */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  // Keep the latest value for the timer closure without re-scheduling on every
  // render (only the effect re-runs when value actually changes).
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(valueRef.current);
    }, delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);

  return debounced;
}
