import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const SAMPLE = fileURLToPath(new URL('../../samples/input.jpg', import.meta.url));

async function waitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => document.body.innerText.includes('ready'), {
    timeout: 180_000,
  });
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon|status of 404/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

test('upload → preview → before/after → export zip', async ({ page }) => {
  const errors = collectErrors(page);
  await waitReady(page);

  await page.setInputFiles('#upload-trigger', SAMPLE);
  await expect(page.getByText('input.jpg').first()).toBeVisible({ timeout: 60_000 });
  // Preview finishes when the frame's processing spinner disappears.
  await expect(
    page.locator('[data-testid="frame-thumb"] .animate-spin'),
  ).toHaveCount(0, { timeout: 60_000 });

  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await page.getByRole('button', { name: 'After', exact: true }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByTestId('export-download').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^rebate-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);

  expect(errors).toEqual([]);
});

test('add more frames, remove one, and undo param changes', async ({ page }) => {
  const errors = collectErrors(page);
  await waitReady(page);

  // First frame.
  await page.setInputFiles('#upload-trigger', SAMPLE);
  await expect(page.locator('[data-testid="frame-thumb"]')).toHaveCount(1, {
    timeout: 60_000,
  });

  // Undo/redo start disabled (no param changes yet).
  const undoBtn = page.getByTitle('Undo (⌘Z)');
  const redoBtn = page.getByTitle('Redo (⌘⇧Z)');
  await expect(undoBtn).toBeDisabled();

  // Apply a preset -> undo becomes available.
  await page.getByRole('button', { name: 'Clean', exact: true }).click();
  await expect(undoBtn).toBeEnabled();

  // Cmd/Ctrl+Z undoes the preset; undo button is disabled again.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeEnabled();

  // Add a second frame through the window drop handler.
  await page.evaluate(({ base64, name, type }) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    const el = document.querySelector('[data-testid="app-root"]');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, {
    base64: fs.readFileSync(SAMPLE).toString('base64'),
    name: 'input.jpg',
    type: 'image/jpeg',
  });
  await expect(page.locator('[data-testid="frame-thumb"]')).toHaveCount(2, {
    timeout: 60_000,
  });

  // Select the last frame and remove it with the Delete key.
  await page.locator('[data-testid="frame-thumb"]').nth(1).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid="frame-thumb"]')).toHaveCount(1, {
    timeout: 30_000,
  });

  expect(errors).toEqual([]);
});
