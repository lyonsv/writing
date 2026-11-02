import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { currentDocument, launch, newLibrary, newUserData, quitAndWait } from './launch';

// First run (M7): an empty library gets "Welcome to Margin.md", once; deleting it never brings it back.
test('first run writes the welcome document into an empty library, once', async () => {
  const lib = newLibrary();
  const userData = newUserData();
  try {
    let app = await launch(lib, { MARGIN_TEST_SKIP_WELCOME: '' }, userData);
    let page = await app.firstWindow();
    expect(await currentDocument(page)).toBe('Welcome to Margin.md');
    await expect(page.getByTestId('editor')).toContainText('Welcome to Margin');
    const text = readFileSync(path.join(lib, 'Welcome to Margin.md'), 'utf8');
    expect(text).toContain('Focus mode');
    await quitAndWait(app);

    // The user deletes it; the next launch doesn't re-create it.
    rmSync(path.join(lib, 'Welcome to Margin.md'));
    app = await launch(lib, { MARGIN_TEST_SKIP_WELCOME: '' }, userData);
    page = await app.firstWindow();
    expect(await currentDocument(page)).not.toBe('Welcome to Margin.md');
    expect(existsSync(path.join(lib, 'Welcome to Margin.md'))).toBe(false);
    await quitAndWait(app);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test('first run with an existing library adds nothing', async () => {
  const lib = newLibrary();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(lib, 'mine.md'), 'my text');
  try {
    const app = await launch(lib, { MARGIN_TEST_SKIP_WELCOME: '' });
    const page = await app.firstWindow();
    expect(await currentDocument(page)).toBe('mine.md');
    expect(readdirSync(lib).filter((f) => f.endsWith('.md'))).toEqual(['mine.md']);
    await quitAndWait(app);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});
