/** Small runtime facts shown in Settings › Diagnostics (e.g. whether the editor font loaded in the WebView). */
const values = new Map<string, string>();
const listeners = new Set<() => void>();

export function setDiagnostic(key: string, value: string): void {
  values.set(key, value);
  for (const l of listeners) l();
}

export function diagnostics(): ReadonlyMap<string, string> {
  return values;
}

export function onDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
