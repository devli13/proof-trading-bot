// Shared framer-motion vocabulary — subtle + buttery over flashy. Derived from the
// design system's --ease-out + --t-base feel. Reduced motion is handled per-component
// via framer's useReducedMotion (layout/count-up become instant; flashes stay).
import type { Transition, Variants } from "framer-motion";

export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Row reorder + treemap resize — fast settle, no overshoot. */
export const layoutSpring: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };
export const enter: Transition = { duration: 0.32, ease: EASE_OUT };
export const fast: Transition = { duration: 0.12, ease: EASE_OUT };

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: enter },
};

export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};

export const drawerVariants: Variants = {
  collapsed: { height: 0, opacity: 0, transition: { duration: 0.24, ease: EASE_OUT } },
  open: { height: "auto", opacity: 1, transition: { duration: 0.28, ease: EASE_OUT } },
};

/** Tiny hover/press affordance for rows, cards, tiles. */
export const pressable = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.997 },
  transition: fast,
};
