import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  baseName,
  zipEntries,
  isZipFile,
  isImageFile,
  extractImagesFromZipBuffer,
} from './imageUtil.js';

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

const fakeFile = (name, type = '') => ({ name, type });

describe('zip helpers', () => {
  it('detects zip and image files', () => {
    expect(isZipFile(fakeFile('roll.zip'))).toBe(true);
    expect(isZipFile(fakeFile('roll.ZIP'))).toBe(true);
    expect(isZipFile(fakeFile('x.jpg'))).toBe(false);
    expect(isZipFile(fakeFile('', 'application/x-zip-compressed'))).toBe(true);

    expect(isImageFile(fakeFile('a.jpg'))).toBe(true);
    expect(isImageFile(fakeFile('a.png'))).toBe(true);
    expect(isImageFile(fakeFile('a.tiff'))).toBe(true);
    expect(isImageFile(fakeFile('a.jpg', 'image/jpeg'))).toBe(true);
    expect(isImageFile(fakeFile('a.zip'))).toBe(false);
    expect(isImageFile(fakeFile('a.txt'))).toBe(false);
  });

  it('extracts images recursively, skipping dirs/junk/non-images', () => {
    const zip = zipSync({
      'roll/photo1.jpg': new Uint8Array([1, 2, 3]),
      'roll/sub/photo2.png': new Uint8Array([4, 5, 6]),
      'roll/sub/deep/photo3.webp': new Uint8Array([7]),
      'roll/notes.txt': new Uint8Array([9]),
      'roll/__MACOSX/junk.jpg': new Uint8Array([9]),
      'roll/.DS_Store': new Uint8Array([9]),
    });
    const files = extractImagesFromZipBuffer(zip);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['photo1.jpg', 'photo2.png', 'photo3.webp']);
    expect(files.every((f) => f instanceof File)).toBe(true);
  });

  it('de-collides duplicate basenames across directories', () => {
    const zip = zipSync({
      'a/photo.jpg': new Uint8Array([1]),
      'b/photo.jpg': new Uint8Array([2]),
      'c/photo.jpg': new Uint8Array([3]),
    });
    const files = extractImagesFromZipBuffer(zip);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['photo-2.jpg', 'photo-3.jpg', 'photo.jpg']);
  });
});
