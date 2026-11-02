import { Redirect } from 'expo-router';

/** iOS-only screen (see the `.native.tsx` file); web and desktop use the single workspace at `/`. */
export default function WebFallback() {
  return <Redirect href="/" />;
}
