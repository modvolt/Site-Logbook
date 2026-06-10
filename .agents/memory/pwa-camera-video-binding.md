---
name: PWA live-camera <video> binding (ZXing scanner)
description: Why the barcode scanner showed a black preview in the iOS standalone PWA and how to bind getUserMedia video reliably inside a portaled dialog.
---

# Live camera preview goes black in iOS PWA

Symptom: barcode/QR scanner dialog opens but the camera preview is solid black
(no error shown). Native photo capture (`<input type="file" accept="image/*"
capture>`) works fine in the same PWA — only the live getUserMedia preview fails.

**Root cause:** the `<video>` lives inside a Radix `Dialog` whose content is
portaled/mounted asynchronously. A plain `useRef` can still be `null` when the
start effect runs, so ZXing's `decodeFromConstraints(constraints, undefined, cb)`
binds the stream to its own internal hidden element instead of the visible one →
black preview. Secondarily, on iOS standalone PWAs the programmatic `play()`
inside ZXing can be dropped because the `await` chain breaks the user-gesture
context.

**Fix (both parts needed):**
1. Bind the live preview to the *actual mounted* element: use a state-backed
   **callback ref** (`const [videoEl,setVideoEl]=useState<HTMLVideoElement|null>`,
   `ref={setVideoEl}`) and gate the start effect on `if (!open || !videoEl) return;`
   with `[open, videoEl]` deps. Never pass `undefined`/possibly-null video to ZXing.
2. Make playback gesture-independent: `<video autoPlay muted playsInline>` **and**
   an explicit `await videoEl.play()` after constraints resolve (muted+playsInline
   makes autoplay allowed without a gesture).

**Why:** native `<input capture>` is a separate OS code path and is unaffected,
so "photos work but scanner is black" points at the getUserMedia/video-binding
path, not at camera permissions.

**How to apply:** any live-camera/getUserMedia preview rendered inside a
portaled/animated dialog — gate init on the real element via callback ref, and
add the autoplay trio + explicit play() for iOS PWA.
