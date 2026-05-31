---
name: PWA safe-area (iOS notch) padding in Tailwind v4
description: Why to inline env(safe-area-inset-*) calc() instead of a flat @utility, and the fixed-bottom-nav height pattern
---

# Safe-area insets for installed PWA (iOS standalone)

For the "Add to Home Screen" standalone PWA, fixed top/bottom chrome must respect
the device safe areas (notch / status bar / home indicator). Requires
`viewport-fit=cover` in the index.html viewport meta, then `env(safe-area-inset-*)`
in CSS.

**Pitfall:** do NOT define a Tailwind v4 `@utility safe-area-top { padding-top:
env(safe-area-inset-top) }`. A flat utility *overrides* any existing padding
utility (e.g. `py-2`) on the same element, so on non-notch devices the element
loses its baseline padding (inset = 0). Instead inline an **additive** arbitrary
value so the base padding is preserved:
`pt-[calc(0.5rem+env(safe-area-inset-top,0px))]`.

**Fixed bottom nav pattern:** to keep the bar's content area constant while the
bar grows over the home indicator, set the height to include the inset AND pad
the bottom by it:
`h-[calc(4rem+env(safe-area-inset-bottom,0px))] pb-[env(safe-area-inset-bottom,0px)]`.
Make the scrollable content's bottom padding match
(`pb-[calc(4rem+env(safe-area-inset-bottom,0px))]`) so nothing hides behind it.

**Why:** the override behaviour is silent — it only shows up as missing padding
on real hardware, never in a desktop preview or typecheck.
