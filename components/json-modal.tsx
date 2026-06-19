"use client";

// Raw /api/stats viewer. AnimatePresence drives mount/unmount so the panel can
// fade + slide on both enter and exit. Backdrop click and Escape both close.
// The base .modal* classes were not ported into globals.css (only the <560px
// .modal-body wrap override + the --z-modal token), so structural styling lives
// inline via design tokens; class names are kept so the existing override and
// .hdr-btn styles still apply.
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { JsonModalProps } from "./contracts";
import { EASE_OUT } from "@/lib/motion";

export function JsonModal({ open, onClose, data }: JsonModalProps) {
  const reduce = useReducedMotion() ?? false;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);

  // Close on Escape while open. Lock nothing else.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus management: on open, remember what was focused and move focus into
  // the dialog (the close button); on close, restore focus to that element.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      prev?.focus?.();
    };
  }, [open]);

  // Reset the transient "copied" label whenever the modal opens/closes.
  useEffect(() => {
    setCopied(false);
  }, [open]);

  function onCopy() {
    void navigator.clipboard
      .writeText(JSON.stringify(data, null, 2))
      .then(() => setCopied(true));
  }

  // Clear the "copied" label after ~1.2s.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const panelTransition = reduce
    ? { duration: 0 }
    : { duration: 0.2, ease: EASE_OUT };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="json-modal"
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: "var(--z-modal)" as unknown as number,
            display: "grid",
            placeItems: "center",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
        >
          <div
            className="modal-backdrop"
            onClick={onClose}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(5,7,11,.6)",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
            }}
          />
          <motion.div
            className="modal-panel"
            style={{
              position: "relative",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-xl)",
              width: "min(720px, calc(100vw - 2 * var(--s4)))",
              maxHeight: "min(80vh, calc(100dvh - 2 * var(--s4)))",
              display: "flex",
              flexDirection: "column",
            }}
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : 8 }}
            transition={panelTransition}
          >
            <div
              className="modal-head"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s2)",
                padding: "var(--s3) var(--s4)",
                borderBottom: "1px solid var(--border)",
                color: "var(--tx-2)",
              }}
            >
              <span id={titleId}>/api/stats</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="hdr-btn"
                aria-label="Copy JSON"
                onClick={onCopy}
              >
                {copied ? "copied" : "copy"}
              </button>
              <button
                ref={closeRef}
                type="button"
                className="hdr-btn"
                aria-label="Close"
                onClick={onClose}
              >
                ✕
              </button>
            </div>
            <pre
              className="modal-body"
              style={{
                overflow: "auto",
                WebkitOverflowScrolling: "touch",
                overscrollBehavior: "contain",
                padding: "var(--s4)",
                margin: 0,
                fontSize: "var(--fz-1)",
                background: "var(--inset)",
                borderRadius: "0 0 var(--r-xl) var(--r-xl)",
                whiteSpace: "pre",
                color: "var(--tx-3)",
              }}
            >
              {data ? JSON.stringify(data, null, 2) : ""}
            </pre>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
