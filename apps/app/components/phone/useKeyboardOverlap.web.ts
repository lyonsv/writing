import { useEffect, useState } from 'react';

/**
 * Web app on a phone (ADR 0020): iOS Safari doesn't shrink the layout viewport
 * for the on-screen keyboard, only the visual viewport. The overlap is what the
 * visual viewport lost at the bottom. While the keyboard is up we also undo the
 * page scroll Safari applies to reveal the caret: our own layout shrinks
 * instead, so the editor's scroller keeps the caret visible and typewriter mode
 * centres in the area above the keyboard.
 */
export function useKeyboardOverlap(): number {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const lost = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // Under ~80px it's browser chrome (URL bar) moving, not a keyboard.
      setOverlap(lost > 80 ? lost : 0);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return overlap;
}
