// Pyodide Web Worker — runs the *same* Python core as the CLI (`rebate/core.py`)
// in the browser. All processing is local; no image bytes ever leave the page.
import corePySource from '../../rebate/core.py?raw';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';
const HOME = '/home/pyodide';

let readyPromise = null;

function post(ok, payload, transfer = []) {
  self.postMessage({ ok, ...payload }, transfer);
}

// Reject `promise` after `ms` so a stalled CDN download can never leave the
// worker (and the UI) waiting forever.
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Load numpy + OpenCV, tolerating a slow/partial wheel download: verify the
// modules are actually importable and, if not, re-resolve via micropip.
async function ensureOpenCV(py) {
  const check = () =>
    py.runPythonAsync('import cv2, numpy').then(() => true, () => false);

  try {
    await py.loadPackage(['numpy', 'opencv-python']);
    if (await check()) return;
  } catch {
    /* retry below */
  }

  // Retry: resolve the wheels directly through micropip (Pyodide's index).
  await py.runPythonAsync(`
import micropip
await micropip.install(['numpy', 'opencv-python'])
`);
  if (!(await check())) {
    throw new Error('OpenCV (cv2) failed to load in Pyodide');
  }
}

async function ensurePyodide() {
  if (readyPromise) return readyPromise;

  readyPromise = withTimeout(
    (async () => {
      post(true, { type: 'status', message: 'Loading Python runtime…' });
      const mod = await import(/* @vite-ignore */ PYODIDE_URL);
      const py = await mod.loadPyodide();

    post(true, { type: 'status', message: 'Loading numpy + OpenCV…' });
    await withTimeout(
      ensureOpenCV(py),
      90_000,
      'Timed out loading OpenCV — check your connection and retry',
    );

    py.FS.writeFile(`${HOME}/rebate_core.py`, corePySource);
    await py.runPythonAsync(`
import sys, json
sys.path.insert(0, ${JSON.stringify(HOME)})
import rebate_core

# Reduce OpenCV threading (the wasm build is single-threaded anyway).
try:
    import cv2
    cv2.setNumThreads(1)
except Exception:
    pass

def _do(in_id, ext, quality, params_json):
    import rebate_core, json
    params = json.loads(params_json)
    data = open(f'${HOME}/{in_id}', 'rb').read()
    img = rebate_core.decode_image(data)
    res = rebate_core.process_image(
        img,
        size=params['size'],
        margin=params['margin'],
        border=params['border'],
        radius=params['radius'],
        roughness=params['roughness'],
        feather=params['feather'],
        seed=params['seed'],
        sprocket_chance=params['sprocket_chance'],
        radius_jitter=params['radius_jitter'],
        square_corner_chance=params['square_corner_chance'],
        border_jitter=params['border_jitter'],
        max_sprocket_border=params['max_sprocket_border'],
        offset_left=params['offset_left'],
        offset_right=params['offset_right'],
        offset_top=params['offset_top'],
        offset_bottom=params['offset_bottom'],
        plain=params['plain'],
        debug=params['debug'],
        waviness=params['waviness'],
        edge_asymmetry=params['edge_asymmetry'],
        gate_override=params.get('gate_override'),
        sprocket_override=params.get('sprocket_override'),
    )
    out_path = f'${HOME}/out_{in_id}{ext}'
    open(out_path, 'wb').write(rebate_core.encode_image(res.image, ext, quality))
    dbg_path = None
    if res.debug_image is not None:
        dbg_path = f'${HOME}/dbg_{in_id}.jpg'
        open(dbg_path, 'wb').write(rebate_core.encode_image(res.debug_image, '.jpg', 90))

    def f(v):
        return None if v is None else float(v)
    def i(v):
        return None if v is None else int(v)
    meta = {
        'gate': [f(x) for x in res.gate_rect] if res.gate_rect else None,
        'crop': [i(x) for x in res.crop_rect] if res.crop_rect else None,
        'plain': [i(x) for x in res.plain_rect] if res.plain_rect else None,
        'sprocket': [f(x) for x in res.sprocket_edges] if res.sprocket_edges else None,
        'shape': list(res.image.shape),
    }
    open(f'${HOME}/meta_{in_id}.json', 'w').write(json.dumps(meta))
    return {'out_path': out_path, 'dbg_path': dbg_path}

def _do_merge(in_id, count, ext, quality, params_json):
    import rebate_core, json
    params = json.loads(params_json)
    images = []
    for i in range(count):
        data = open(f'${HOME}/merge_{in_id}_{i}', 'rb').read()
        images.append(rebate_core.decode_image(data))
    res = rebate_core.process_merge(
        images,
        size=params['size'],
        margin=params['margin'],
        border=params['border'],
        radius=params['radius'],
        roughness=params['roughness'],
        feather=params['feather'],
        seed=params['seed'],
        sprocket_chance=params['sprocket_chance'],
        radius_jitter=params['radius_jitter'],
        square_corner_chance=params['square_corner_chance'],
        border_jitter=params['border_jitter'],
        max_sprocket_border=params['max_sprocket_border'],
        gap=params['gap'],
        layout=params['layout'],
        waviness=params['waviness'],
        edge_asymmetry=params['edge_asymmetry'],
        canvas_size=params.get('canvas_size'),
        per_image=params.get('per_image'),
    )
    out_path = f'${HOME}/mergeout_{in_id}{ext}'
    open(out_path, 'wb').write(rebate_core.encode_image(res, ext, quality))
    meta = {'shape': list(res.shape)}
    open(f'${HOME}/mergemeta_{in_id}.json', 'w').write(json.dumps(meta))
    return {'out_path': out_path}
`);

    post(true, { type: 'ready' });
    return py;
    })(),
    180_000,
    'Pyodide failed to start in time — check your connection and reload',
  );

  return readyPromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      await ensurePyodide();
      return;
    }

    if (msg.type === 'process') {
      const py = await ensurePyodide();
      const { id, buffer, params } = msg;

      py.FS.writeFile(`${HOME}/${id}`, new Uint8Array(buffer));
      py.globals.set('_in_id', id);
      py.globals.set('_ext', params.format === 'png' ? '.png' : '.jpg');
      py.globals.set('_quality', params.quality ?? 100);
      py.globals.set('_params_json', JSON.stringify(params));

      py.runPython('_do(_in_id, _ext, _quality, _params_json)');

      const outPath = `${HOME}/out_${id}${params.format === 'png' ? '.png' : '.jpg'}`;
      const imageBytes = py.FS.readFile(outPath);
      const imageMime = params.format === 'png' ? 'image/png' : 'image/jpeg';

      let debugBytes = null;
      const dbgPath = `${HOME}/dbg_${id}.jpg`;
      try {
        debugBytes = py.FS.readFile(dbgPath);
      } catch {
        debugBytes = null;
      }

      const metaText = py.FS.readFile(`${HOME}/meta_${id}.json`, { encoding: 'utf8' });
      const meta = JSON.parse(metaText);

      // Free FS space for the next image.
      for (const p of [`${HOME}/${id}`, outPath, dbgPath, `${HOME}/meta_${id}.json`]) {
        try { py.FS.unlink(p); } catch { /* ignore */ }
      }

      // Copy into fresh ArrayBuffers before transferring (the wasm heap's
      // backing buffer may not be a transferable type in all browsers).
      const transfer = [];
      const imageBuffer = imageBytes.slice().buffer;
      transfer.push(imageBuffer);
      let debugBuffer = null;
      if (debugBytes) {
        debugBuffer = debugBytes.slice().buffer;
        transfer.push(debugBuffer);
      }

      post(true, {
        type: 'result',
        id,
        imageBuffer,
        imageMime,
        debugBuffer,
        debugMime: 'image/jpeg',
        meta,
      }, transfer);
      return;
    }

    if (msg.type === 'processMerge') {
      const py = await ensurePyodide();
      const { id, buffers, params } = msg;
      const ext = params.format === 'png' ? '.png' : '.jpg';

      for (let i = 0; i < buffers.length; i++) {
        py.FS.writeFile(`${HOME}/merge_${id}_${i}`, new Uint8Array(buffers[i]));
      }
      py.globals.set('_in_id', id);
      py.globals.set('_count', buffers.length);
      py.globals.set('_ext', ext);
      py.globals.set('_quality', params.quality ?? 100);
      py.globals.set('_params_json', JSON.stringify(params));

      py.runPython('_do_merge(_in_id, _count, _ext, _quality, _params_json)');

      const outPath = `${HOME}/mergeout_${id}${ext}`;
      const imageBytes = py.FS.readFile(outPath);
      const imageMime = ext === '.png' ? 'image/png' : 'image/jpeg';

      const metaText = py.FS.readFile(`${HOME}/mergemeta_${id}.json`, { encoding: 'utf8' });
      const meta = JSON.parse(metaText);

      for (let i = 0; i < buffers.length; i++) {
        try { py.FS.unlink(`${HOME}/merge_${id}_${i}`); } catch { /* ignore */ }
      }
      for (const p of [outPath, `${HOME}/mergemeta_${id}.json`]) {
        try { py.FS.unlink(p); } catch { /* ignore */ }
      }

      const transfer = [];
      const imageBuffer = imageBytes.slice().buffer;
      transfer.push(imageBuffer);

      post(true, {
        type: 'result',
        id,
        imageBuffer,
        imageMime,
        debugBuffer: null,
        debugMime: null,
        meta,
      }, transfer);
      return;
    }
  } catch (err) {
    post(false, { type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
