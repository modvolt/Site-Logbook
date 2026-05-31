import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

const THRESHOLD = 70;
const MAX_PULL = 110;
const RESISTANCE = 0.5;

type PullToRefreshProps = {
  onRefresh: () => Promise<unknown> | void;
  children: React.ReactNode;
};

export function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const dragging = useRef(false);
  const state = useRef({ startY: 0, active: false, pull: 0 });
  const refreshingRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      if (window.scrollY > 0) {
        state.current.active = false;
        return;
      }
      state.current.startY = e.touches[0].clientY;
      state.current.active = true;
      dragging.current = true;
    };

    const onMove = (e: TouchEvent) => {
      const s = state.current;
      if (!s.active || refreshingRef.current) return;
      const dy = e.touches[0].clientY - s.startY;
      if (dy <= 0 || window.scrollY > 0) {
        if (s.pull !== 0) {
          s.pull = 0;
          setPull(0);
        }
        if (window.scrollY > 0) s.active = false;
        return;
      }
      e.preventDefault();
      const dist = Math.min(MAX_PULL, dy * RESISTANCE);
      s.pull = dist;
      setPull(dist);
    };

    const onEnd = () => {
      const s = state.current;
      if (!s.active) return;
      s.active = false;
      dragging.current = false;
      if (s.pull >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        Promise.resolve(onRefresh()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          s.pull = 0;
          setPull(0);
        });
      } else {
        s.pull = 0;
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [onRefresh]);

  const progress = Math.min(1, pull / THRESHOLD);
  const spinning = refreshing || pull >= THRESHOLD;

  return (
    <div ref={containerRef}>
      <div
        className="md:hidden flex items-end justify-center overflow-hidden"
        style={{
          height: pull,
          transition: dragging.current ? "none" : "height 0.2s ease",
        }}
      >
        <div className="pb-2">
          <RefreshCw
            className={`h-6 w-6 text-primary ${spinning ? "animate-spin" : ""}`}
            style={{
              opacity: progress,
              transform: spinning ? undefined : `rotate(${pull * 2.5}deg)`,
            }}
          />
        </div>
      </div>
      {children}
    </div>
  );
}
