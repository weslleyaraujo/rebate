import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { baseName, zipEntries } from './imageUtil.js';

describe('baseName', () => {
  it('strips the last extension', () => {
    expect(baseName('roll-001-positive.jpg')).toBe('roll-001-positive');
    expect(baseName('noext')).toBe('noext');
  });
});

describe('zipEntries', () => {
  it('produces a valid zip with the expected entries', async () => {
    const entries = [
      { name: 'a.jpg', buffer: new Uint8Array([1, 2, 3]) },
      { name: 'b.png', buffer: new Uint8Array([4, 5, 6]) },
    ];
    const blob = zipEntries(entries);
    expect(blob.type).toBe('application/zip');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['a.jpg', 'b.png']);
    expect(Array.from(files['a.jpg'])).toEqual([1, 2, 3]);
    expect(Array.from(files['b.png'])).toEqual([4, 5, 6]);
  });

  it('accepts ArrayBuffers too', async () => {
    const buf = new Uint8Array([9, 9]).buffer;
    const blob = zipEntries([{ name: 'x.jpg', buffer: buf }]);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Array.from(files['x.jpg'])).toEqual([9, 9]);
  });
});
