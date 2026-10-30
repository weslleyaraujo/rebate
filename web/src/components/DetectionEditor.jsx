import { useCallback, useEffect, useRef, useState } from 'react';

// Screen-space hit radius (px) for grabbing gate edges/corners and sprocket
// lines. Converted to full-scan px internally using the current view scale.
const HANDLE = 12;

// Minimum gate size in full-scan px (prevents collapsing a rect while dragging).
const MIN_GATE = 16;

function clampRect(l, t, r, b, Lw, Lh) {
  let nl = Math.min(l, r);
  let nr = Math.max(l, r);
  let nt = Math.min(t, b);
  let nb = Math.max(t, b);
  nl = Math.max(0, Math.min(nl, Lw - MIN_GATE));
  nt = Math.max(0, Math.min(nt, Lh - MIN_GATE));
  nr = Math.max(nl + MIN_GATE, Math.min(nr, Lw));
  nb = Math.max(nt + MIN_GATE, Math.min(nb, Lh));
  return [nl, nt, nr, nb];
}

// Live approximation of the final crop window (border + offsets). It ignores
// border-jitter and the sprocket sliver (both are random and only finalized
// when the pipeline re-runs on Done), so it's a deterministic guide that
// follows the green gate instantly.
function computeCrop(gate, params, Lw, Lh) {
  const [l, t, r, b] = gate;
  const gateH = b - t;
  const pad = (params?.border ?? 0.025) * gateH;
  const cw = Math.round((r - l) + 2 * pad);
  const ch = Math.round(gateH + 2 * pad);
  let cl = Math.max(0, Math.min(Math.round(l - pad), Lw - cw));
  let ct = Math.max(0, Math.min(Math.round(t - pad), Lh - ch));
  let cr = cl + cw;
  let cb = ct + ch;
  // Offsets are in full-scan px; positive reveals more (expands), negative trims.
  cl = Math.max(0, Math.round(cl - (params?.offset_left ?? 0)));
  cr = Math.min(Lw, Math.round(cr + (params?.offset_right ?? 0)));
  ct = Math.max(0, Math.round(ct - (params?.offset_top ?? 0)));
  cb = Math.min(Lh, Math.round(cb + (params?.offset_bottom ?? 0)));
  if (cl >= cr) cl = cr - 1;
  if (ct >= cb) ct = cb - 1;
  return [cl, ct, cr, cb];
}

export default function DetectionEditor({
  image,
  params,
  gateOverride,
  sprocketOverride,
  locked,
  onGateChange,
  onSprocketChange,
  onReset,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [srcImg, setSrcImg] = useState(null);

  // Offscreen canvas holding the full scan in LANDSCAPE orientation (the same
  // orientation the detector sees after portrait rotation), so every overlay
  // coordinate is plain landscape px.
  const landscapeRef = useRef(null);
  const viewRef = useRef({ s: 1, ox: 0, oy: 0, Lw: 0, Lh: 0 });
  const gateRef = useRef(null);
  const sprocketRef = useRef(null);
  const dragRef = useRef(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Detection meta arrives in preview px (the preview may be downscaled);
  // convert to full-scan landscape px so it overlays the full-res original.
  const factor = image.previewFactor || 1;
  const rects = image.rects || {};
  const detectedGate = rects.gate
    ? rects.gate.map((v) => Math.round(v / factor))
    : null;
  const detectedSprocket = rects.sprocket
    ? rects.sprocket.map((v) => (v == null ? null : Math.round(v / factor)))
    : null;

  const effectiveGate = gateOverride || detectedGate;
  const effectiveSprocket = sprocketOverride || detectedSprocket;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const off = landscapeRef.current;
    if (!canvas || !off) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;
    const w = Math.round(cw * dpr);
    const h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, cw, ch);

    const Lw = off.width;
    const Lh = off.height;
    const s = Math.min(cw / Lw, ch / Lh);
    const ox = (cw - Lw * s) / 2;
    const oy = (ch - Lh * s) / 2;
    viewRef.current = { s, ox, oy, Lw, Lh };

    ctx.drawImage(off, ox, oy, Lw * s, Lh * s);

    const strokeRect = (r, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(
        ox + r[0] * s,
        oy + r[1] * s,
        (r[2] - r[0]) * s,
        (r[3] - r[1]) * s,
      );
    };

    // Final crop window (red) — read-only; computed live from the gate so it
    // follows instantly while dragging.
    const gateNow = gateRef.current;
    if (gateNow) {
      strokeRect(
        computeCrop(gateNow, paramsRef.current, Lw, Lh),
        'rgba(255,72,72,0.9)',
        1.5,
      );
    }

    // Sprocket inner edges (cyan) — draggable horizontal lines.
    const sp = sprocketRef.current;
    if (sp) {
      ctx.strokeStyle = 'rgba(96,220,255,0.95)';
      ctx.lineWidth = 2;
      ctx.font = '11px ui-sans-serif, system-ui';
      const labels = ['top sprockets', 'bottom sprockets'];
      sp.forEach((y, i) => {
        if (y == null) return;
        const yy = oy + y * s;
        ctx.beginPath();
        ctx.moveTo(ox, yy);
        ctx.lineTo(ox + Lw * s, yy);
        ctx.stroke();
        ctx.fillStyle = 'rgba(96,220,255,0.95)';
        ctx.fillText(labels[i], ox + 6, Math.max(10, yy - 4));
      });
    }

    // Detected/manual gate (green) — draggable + resizable.
    const g = gateRef.current;
    if (g) {
      strokeRect(g, 'rgba(0,255,132,0.95)', 2);
      ctx.fillStyle = 'rgba(0,255,132,0.95)';
      const corners = [
        [g[0], g[1]],
        [g[2], g[1]],
        [g[0], g[3]],
        [g[2], g[3]],
      ];
      for (const [x, y] of corners) {
        ctx.beginPath();
        ctx.arc(ox + x * s, oy + y * s, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, []);

  // Load the full-res source image (original orientation).
  useEffect(() => {
    let alive = true;
    const el = new Image();
    el.onload = () => {
      if (alive) setSrcImg(el);
    };
    el.src = image.beforeUrl;
    return () => {
      alive = false;
    };
  }, [image.beforeUrl]);

  // Build the landscape offscreen canvas once per image (rotates portrait
  // scans 90° clockwise to match `process_image`).
  useEffect(() => {
    if (!srcImg) {
      landscapeRef.current = null;
      return;
    }
    const portrait = srcImg.naturalHeight > srcImg.naturalWidth;
    const Lw = portrait ? srcImg.naturalHeight : srcImg.naturalWidth;
    const Lh = portrait ? srcImg.naturalWidth : srcImg.naturalHeight;
    const off = document.createElement('canvas');
    off.width = Lw;
    off.height = Lh;
    const c = off.getContext('2d');
    c.fillStyle = '#0b0b0c';
    c.fillRect(0, 0, Lw, Lh);
    if (portrait) {
      c.translate(Lw - 1, 0);
      c.rotate(Math.PI / 2);
      c.drawImage(srcImg, 0, 0);
    } else {
      c.drawImage(srcImg, 0, 0);
    }
    landscapeRef.current = off;
    gateRef.current = gateOverride || detectedGate;
    sprocketRef.current = sprocketOverride || detectedSprocket;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcImg]);

  // Keep refs in sync when overrides or preview meta change externally. Skipped
  // while a drag is in progress so an unrelated re-render can't snap the draft.
  useEffect(() => {
    if (dragRef.current) return;
    gateRef.current = gateOverride || detectedGate;
    sprocketRef.current = sprocketOverride || detectedSprocket;
    draw();
  });

  // (Re)draw whenever the container resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  const toLandscape = useCallback((e) => {
    const canvas = canvasRef.current;
    const v = viewRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return {
      lx: (cx - v.ox) / v.s,
      ly: (cy - v.oy) / v.s,
      tol: HANDLE / v.s,
    };
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      if (locked) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      const { lx, ly, tol } = toLandscape(e);
      const g = gateRef.current;
      const sp = sprocketRef.current;

      if (g) {
        // 1. Corner handles.
        const corners = [
          ['tl', g[0], g[1]],
          ['tr', g[2], g[1]],
          ['bl', g[0], g[3]],
          ['br', g[2], g[3]],
        ];
        for (const [name, x, y] of corners) {
          if (Math.abs(lx - x) <= tol && Math.abs(ly - y) <= tol) {
            dragRef.current = {
              mode: 'corner', which: name,
              startGate: [...g], startSprocket: sp ? [...sp] : null,
              startLx: lx, startLy: ly,
            };
            return;
          }
        }
        // 2. Edge handles.
        const nearLeft = Math.abs(lx - g[0]) <= tol && ly >= g[1] - tol && ly <= g[3] + tol;
        const nearRight = Math.abs(lx - g[2]) <= tol && ly >= g[1] - tol && ly <= g[3] + tol;
        const nearTop = Math.abs(ly - g[1]) <= tol && lx >= g[0] - tol && lx <= g[2] + tol;
        const nearBottom = Math.abs(ly - g[3]) <= tol && lx >= g[0] - tol && lx <= g[2] + tol;
        if (nearLeft || nearRight || nearTop || nearBottom) {
          const which = nearLeft ? 'left' : nearRight ? 'right' : nearTop ? 'top' : 'bottom';
          dragRef.current = {
            mode: 'edge', which,
            startGate: [...g], startSprocket: sp ? [...sp] : null,
            startLx: lx, startLy: ly,
          };
          return;
        }
        // 3. Move the whole gate from its interior.
        if (lx > g[0] && lx < g[2] && ly > g[1] && ly < g[3]) {
          dragRef.current = {
            mode: 'move',
            startGate: [...g], startSprocket: sp ? [...sp] : null,
            startLx: lx, startLy: ly,
          };
          return;
        }
      }

      // 4. Sprocket lines.
      if (sp) {
        for (let i = 0; i < 2; i++) {
          if (sp[i] == null) continue;
          if (Math.abs(ly - sp[i]) <= tol) {
            dragRef.current = {
              mode: 'sprocket', which: i,
              startGate: g ? [...g] : null, startSprocket: [...sp],
              startLx: lx, startLy: ly,
            };
            return;
          }
        }
      }

      // 5. No gate yet: drag to draw one from scratch.
      if (!g) {
        dragRef.current = {
          mode: 'create',
          startGate: [lx, ly, lx, ly], startSprocket: sp ? [...sp] : null,
          startLx: lx, startLy: ly,
        };
      }
    },
    [locked, toLandscape],
  );

  const onPointerMove = useCallback(
    (e) => {
      const d = dragRef.current;
      if (!d) return;
      d.moved = true;
      const { lx, ly } = toLandscape(e);
      const v = viewRef.current;
      const dx = lx - d.startLx;
      const dy = ly - d.startLy;

      if (d.mode === 'move') {
        const w = d.startGate[2] - d.startGate[0];
        const h = d.startGate[3] - d.startGate[1];
        let nl = d.startGate[0] + dx;
        let nt = d.startGate[1] + dy;
        nl = Math.max(0, Math.min(nl, v.Lw - w));
        nt = Math.max(0, Math.min(nt, v.Lh - h));
        gateRef.current = [nl, nt, nl + w, nt + h];
      } else if (d.mode === 'corner' || d.mode === 'edge') {
        const [L, T, R, B] = d.startGate;
        let nl = L;
        let nt = T;
        let nr = R;
        let nb = B;
        if (d.mode === 'corner') {
          if (d.which.includes('l')) nl = L + dx;
          else nr = R + dx;
          if (d.which.includes('t')) nt = T + dy;
          else nb = B + dy;
        } else if (d.which === 'left') nl = L + dx;
        else if (d.which === 'right') nr = R + dx;
        else if (d.which === 'top') nt = T + dy;
        else nb = B + dy;
        gateRef.current = clampRect(nl, nt, nr, nb, v.Lw, v.Lh);
      } else if (d.mode === 'create') {
        gateRef.current = clampRect(
          d.startGate[0], d.startGate[1], lx, ly, v.Lw, v.Lh,
        );
      } else if (d.mode === 'sprocket') {
        const sp = [...d.startSprocket];
        sp[d.which] = Math.max(0, Math.min(d.startSprocket[d.which] + dy, v.Lh));
        sprocketRef.current = sp;
      }

      draw();
    },
    [draw, toLandscape],
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.moved) {
      if (d.mode === 'sprocket') {
        if (sprocketRef.current) {
          onSprocketChange(sprocketRef.current.map((v) => (v == null ? null : Math.round(v))));
        }
      } else if (gateRef.current) {
        onGateChange(gateRef.current.map((v) => Math.round(v)));
      }
    }
    draw();
  }, [draw, onGateChange, onSprocketChange]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden touch-none select-none"
      style={{ cursor: locked ? 'default' : 'crosshair' }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/70 text-[11px] text-neutral-300 backdrop-blur pointer-events-none">
        {locked
          ? 'Frame is locked — unlock to edit detection.'
          : effectiveGate
            ? 'Drag the green gate (or its handles) to fix detection.'
            : 'Drag to draw the frame.'}
      </div>

      <div className="absolute top-2 right-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          disabled={locked || (!gateOverride && !sprocketOverride)}
          className="px-2.5 h-7 text-xs rounded bg-black/70 text-neutral-200 hover:bg-black/90 disabled:opacity-40"
        >
          Auto
        </button>
      </div>
    </div>
  );
}
