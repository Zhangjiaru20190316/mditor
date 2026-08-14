// TEMPORARY: drain leak counters + heap sample into memory.log every 10s so an
// idle heap leak can be attributed to a specific handler (see lib/leakCounters).
// Mount once at the App root. Remove once the leak is found.

import { useEffect } from "react";
import { drainLeakCounters } from "../lib/leakCounters";

export function useLeakProbe(): void {
  useEffect(() => {
    const id = window.setInterval(() => {
      void drainLeakCounters();
    }, 10_000);
    return () => window.clearInterval(id);
  }, []);
}
