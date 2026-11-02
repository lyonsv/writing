import { useEffect, useState } from 'react';
import { Keyboard, LayoutAnimation, useWindowDimensions, type KeyboardEvent } from 'react-native';

/** iOS: how far the keyboard overlaps the window (0 when hidden), animated with the keyboard (ADR 0016). */
export function useKeyboardOverlap(): number {
  const { height } = useWindowDimensions();
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    const animate = (e: KeyboardEvent) => {
      if (e.duration) LayoutAnimation.configureNext({ duration: e.duration, update: { type: LayoutAnimation.Types.keyboard } });
    };
    const change = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
      animate(e);
      setOverlap(Math.max(0, height - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      animate(e);
      setOverlap(0);
    });
    return () => {
      change.remove();
      hide.remove();
    };
  }, [height]);
  return overlap;
}
