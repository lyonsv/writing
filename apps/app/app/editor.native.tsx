import { basename, displayName, effectiveFocusScope } from '@margin/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
  type KeyboardEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MarkdownEditor, { type EditorCommand } from '../components/editor/MarkdownEditor';
import { setEditorFlusher } from '../src/editorFlush';
import { inlineFontCss } from '../src/native/fonts';
import { setDiagnostic } from '../src/native/diagnostics';
import { DARK, LIGHT } from '../src/native/palette';
import { syncLabel, useSyncStatus } from '../src/useSyncStatus';
import { useShared } from '../src/WorkspaceContext';

/** How far the keyboard overlaps the window (0 when hidden). */
function useKeyboardOverlap(): number {
  const { height } = useWindowDimensions();
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    const animate = (e: KeyboardEvent) => {
      if (e.duration) {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
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

/**
 * iOS editor (ADR 0016): the shared CodeMirror DOM component, sized to the area
 * above the keyboard so the caret stays visible and typewriter mode centres in
 * what you can see. A minimal accessory bar sits on the keyboard (Library,
 * focus mode, focus scope, typewriter, hide keyboard); in focus mode with the
 * keyboard down there is no chrome at all and the status bar is hidden.
 */
export default function EditorScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const colors = useColorScheme() === 'dark' ? DARK : LIGHT;
  const { settings, update, toggleFocus, ws } = useShared();
  const syncStatus = useSyncStatus();
  const keyboard = useKeyboardOverlap();
  const [fontCss, setFontCss] = useState<string | null>(null);
  const [fontReady, setFontReady] = useState(false);
  const [flushRequest, setFlushRequest] = useState(0);
  const [blurRequest, setBlurRequest] = useState(0);
  const waiters = useRef(new Map<number, () => void>());
  const nextFlush = useRef(0);

  useEffect(() => {
    let live = true;
    inlineFontCss()
      .then((css) => live && setFontCss(css))
      .catch((e: unknown) => setDiagnostic('font', `Couldn’t read the bundled font: ${String(e)}`))
      .finally(() => live && setFontReady(true));
    return () => {
      live = false;
    };
  }, []);

  // The workspace flushes the editor through the DOM bridge: ask, then wait for the answer.
  useEffect(
    () =>
      setEditorFlusher(
        () =>
          new Promise<void>((resolve) => {
            const id = ++nextFlush.current;
            const timer = setTimeout(() => {
              waiters.current.delete(id);
              resolve(); // an editor that doesn't answer (not mounted yet) has nothing unsaved
            }, 1500);
            waiters.current.set(id, () => {
              clearTimeout(timer);
              resolve();
            });
            setFlushRequest(id);
          }),
      ),
    [],
  );

  // Leaving the editor (back to the library) saves what was typed.
  useFocusEffect(
    useCallback(
      () => () => {
        void ws.flush();
      },
      [ws],
    ),
  );

  const runEditorCommand = useCallback(
    async (command: EditorCommand) => {
      switch (command) {
        case 'toggle-focus':
          return toggleFocus();
        case 'toggle-typewriter':
          return update({ typewriter: !settings.typewriter });
        case 'scope-sentence':
          return update({ focusScope: 'sentence' });
        case 'scope-paragraph':
          return update({ focusScope: 'paragraph' });
        case 'scope-off':
          return update({ focusScope: 'off' });
        case 'new-document':
          return void (await ws.createDocument());
        case 'quick-open':
          return router.navigate({ pathname: '/', params: { search: String(Date.now()) } });
        case 'toggle-sidebar':
          return router.navigate('/');
      }
    },
    [toggleFocus, update, settings.typewriter, ws, router],
  );

  const focus = settings.focusMode;
  const showBar = keyboard > 0 || !focus;
  const status = ws.saveStatus === 'error' ? 'Not saved — retrying' : (ws.warning ?? (focus ? null : ws.notice));
  const sync = focus ? null : syncLabel(syncStatus);
  const scopeLabel = settings.focusScope === 'sentence' ? 'Sentence' : settings.focusScope === 'paragraph' ? 'Paragraph' : 'No dim';
  const nextScope = settings.focusScope === 'sentence' ? 'paragraph' : settings.focusScope === 'paragraph' ? 'off' : 'sentence';
  const title = ws.session ? displayName(basename(ws.session.path)) : '';

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: keyboard > 0 ? keyboard : 0 }]}>
      <StatusBar style="auto" hidden={focus} animated />
      {!focus ? (
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.titleText, { color: colors.muted }]} accessibilityRole="header">
            {title}
          </Text>
        </View>
      ) : null}
      <View style={styles.editor}>
        {ws.session && fontReady ? (
          <MarkdownEditor
            key={ws.session.id}
            initialValue={ws.session.initialText}
            readOnly={ws.session.readOnly}
            onChange={ws.onChange}
            external={ws.external}
            onExternalResult={ws.onExternalResult}
            focusMode={focus}
            focusScope={effectiveFocusScope(settings)}
            typewriter={settings.typewriter}
            onCommand={runEditorCommand}
            fontCss={fontCss ?? undefined}
            fontScale={fontScale}
            onFontStatus={async (s) => setDiagnostic('font', s)}
            flushRequest={flushRequest}
            onFlushed={async (id) => {
              waiters.current.get(id)?.();
              waiters.current.delete(id);
            }}
            blurRequest={blurRequest}
            dom={{
              style: { flex: 1, backgroundColor: colors.bg },
              matchContents: false,
              scrollEnabled: false,
              bounces: false,
              hideKeyboardAccessoryView: true,
              contentInsetAdjustmentBehavior: 'never',
              automaticallyAdjustContentInsets: false,
            }}
          />
        ) : ws.loadError ? (
          <Text style={[styles.message, { color: colors.text }]}>{ws.loadError}</Text>
        ) : null}
      </View>

      {status || sync ? (
        <View style={styles.statusRow} pointerEvents="none">
          {sync ? (
            <Text numberOfLines={1} style={[styles.status, { color: syncStatus?.state === 'error' ? colors.danger : colors.muted, flex: 1 }]}>
              {sync}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {status ? (
            <Text accessibilityRole="alert" style={[styles.status, { color: ws.saveStatus === 'error' || ws.warning ? colors.danger : colors.muted }]}>
              {status}
            </Text>
          ) : null}
        </View>
      ) : null}

      {showBar ? (
        <View
          style={[
            styles.bar,
            { borderTopColor: colors.active, backgroundColor: colors.bg, paddingBottom: keyboard > 0 ? 6 : Math.max(insets.bottom, 6) },
          ]}
          accessibilityRole="toolbar"
        >
          <Bar label="‹ Library" onPress={() => router.navigate('/')} color={colors.muted} a11y="Back to the library" />
          <View style={{ flex: 1 }} />
          <Bar label="Focus" active={focus} onPress={() => void toggleFocus()} color={focus ? colors.text : colors.muted} a11y="Focus mode" />
          <Bar
            label={scopeLabel}
            onPress={() => void update({ focusScope: nextScope })}
            color={colors.muted}
            a11y={`Focus on: ${scopeLabel}. Tap to change.`}
          />
          <Bar
            label="Typewriter"
            active={settings.typewriter}
            onPress={() => void update({ typewriter: !settings.typewriter })}
            color={settings.typewriter ? colors.text : colors.muted}
            a11y="Typewriter scrolling"
          />
          {keyboard > 0 ? <Bar label="Done" onPress={() => setBlurRequest((n) => n + 1)} color={colors.text} a11y="Hide keyboard" /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Bar({ label, onPress, color, active, a11y }: { label: string; onPress: () => void; color: string; active?: boolean; a11y: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.barButton}
      accessibilityRole={active === undefined ? 'button' : 'switch'}
      accessibilityLabel={a11y}
      accessibilityState={active === undefined ? undefined : { checked: active }}
    >
      <Text maxFontSizeMultiplier={1.4} style={[styles.barText, { color, fontWeight: active ? '600' : '400' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  titleRow: { paddingHorizontal: 20, paddingVertical: 4 },
  titleText: { fontSize: 13, textAlign: 'center' },
  editor: { flex: 1 },
  message: { margin: 24 },
  statusRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 4, gap: 12 },
  status: { fontSize: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  barButton: { paddingHorizontal: 8, paddingVertical: 6 },
  barText: { fontSize: 15 },
});
