// Derive the annotation list from the live markdown mirror.
//
// Runs the parser on a useDeferredValue copy of the document so a fast typist
// in a long document doesn't re-parse on every keystroke — same pattern the
// word-count in App.tsx already uses.

import { useDeferredValue, useMemo } from "react";
import { parseAnnotations, type Annotation } from "../lib/annotations";
import { useDebouncedValue } from "./useDebouncedValue";

export function useAnnotations(markdown: string): Annotation[] {
  // T5: debounce before deferring so a typing burst triggers a single reparse
  // (not one per keystroke), still non-blocking and eventually consistent.
  const debounced = useDebouncedValue(markdown, 150);
  const deferred = useDeferredValue(debounced);
  return useMemo(() => parseAnnotations(deferred), [deferred]);
}
