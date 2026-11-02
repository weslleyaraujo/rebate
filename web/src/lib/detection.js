// Pin the auto-detected gate/sprocket from a frame's preview into the params,
// so a native download/export reproduces the exact crop the user saw on screen
// instead of re-running detection at native resolution (which can differ by a
// few pixels and shift the border).
export function pinDetectionFromPreview(image, params) {
  const rects = image.rects;
  const factor = image.previewFactor || 1;
  if (!rects) return params;

  const out = { ...params };

  // Only pin AUTO detection. If the user set a manual gate/sprocket override,
  // honor it (the preview meta may still reflect the previous auto result).
  if (!Array.isArray(out.gate_override) && Array.isArray(rects.gate)) {
    out.gate_override = rects.gate.map((v) => Math.round(v / factor));
  }
  if (!Array.isArray(out.sprocket_override) && Array.isArray(rects.sprocket)) {
    out.sprocket_override = rects.sprocket.map((v) =>
      v == null ? null : Math.round(v / factor),
    );
  }

  return out;
}
