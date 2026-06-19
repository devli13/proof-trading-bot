"use client";
import { AnimatePresence, motion } from "framer-motion";

/** A thin indeterminate progress bar pinned to the very top of the viewport — shown
 *  while a range-change refetch is in flight so the whole-page reload reads as "loading"
 *  even before the new data lands. Pure CSS animation; respects reduced-motion via opacity. */
export function LoadingBar({ active }: { active: boolean }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="loading-bar"
          role="progressbar"
          aria-label="Loading new window"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <span className="loading-bar-fill" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
