import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { EditorScreen } from '../components/phone/EditorScreen';

export default function EditorRoute() {
  const [active, setActive] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setActive(true);
      return () => setActive(false);
    }, []),
  );
  return <EditorScreen active={active} />;
}
