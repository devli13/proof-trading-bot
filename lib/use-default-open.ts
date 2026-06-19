"use client";
import { useEffect, useState } from "react";

/**
 * Initial open-state for a collapsible section: OPEN on desktop, CLOSED on mobile
 * (<560px) so the phone page isn't an endless scroll. Resolved after mount (SSR-safe);
 * the user can still toggle freely afterward.
 */
export function useDefaultOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(!(typeof window !== "undefined" && !!window.matchMedia?.("(max-width:559px)").matches));
  }, []);
  return [open, setOpen];
}
