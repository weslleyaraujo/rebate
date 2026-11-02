import { describe, it, expect } from 'vitest';
import { pinDetectionFromPreview } from './detection.js';

describe('pinDetectionFromPreview', () => {
  it('pins auto-detected gate/sprocket from preview meta (scaled back to native)', () => {
    const out = pinDetectionFromPreview(
      {
        previewFactor: 0.5,
        rects: {
          gate: [50, 100, 300, 400],
          sprocket: [80, 420],
        },
      },
      {},
    );
    expect(out.gate_override).toEqual([100, 200, 600, 800]);
    expect(out.sprocket_override).toEqual([160, 840]);
  });

  it('preserves null sprocket sides', () => {
    const out = pinDetectionFromPreview(
      {
        previewFactor: 0.5,
        rects: { gate: [50, 100, 300, 400], sprocket: [null, 420] },
      },
      {},
    );
    expect(out.sprocket_override).toEqual([null, 840]);
  });

  it('does not override an explicit manual gate/sprocket override', () => {
    const out = pinDetectionFromPreview(
      {
        previewFactor: 0.5,
        rects: { gate: [50, 100, 300, 400], sprocket: [80, 420] },
      },
      { gate_override: [1, 2, 3, 4], sprocket_override: [7, 8] },
    );
    expect(out.gate_override).toEqual([1, 2, 3, 4]);
    expect(out.sprocket_override).toEqual([7, 8]);
  });

  it('returns params unchanged when there is no preview meta', () => {
    const params = { border: 0.03 };
    expect(pinDetectionFromPreview({ previewFactor: 1, rects: null }, params)).toBe(params);
  });

  it('pins sprocket even when only the gate is manually overridden', () => {
    const out = pinDetectionFromPreview(
      { previewFactor: 0.5, rects: { gate: [50, 100, 300, 400], sprocket: [80, 420] } },
      { gate_override: [1, 2, 3, 4] },
    );
    expect(out.gate_override).toEqual([1, 2, 3, 4]);
    expect(out.sprocket_override).toEqual([160, 840]);
  });
});
