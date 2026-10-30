// Thin wrapper around the Pyodide Web Worker.

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }
let readyResolve;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});
let statusHandler = null;
let errorHandler = null;

function ensureWorker() {
  if (!worker) {
    worker = new Worker(new URL('../worker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'status') {
        statusHandler?.(msg.message);
        return;
      }
      if (msg.type === 'ready') {
        readyResolve();
        statusHandler?.('ready');
        return;
      }
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      if (msg.type === 'error') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.message));
        } else {
          errorHandler?.(msg.message);
        }
      }
    };
    worker.onerror = (e) => {
      const message = e.message || 'worker error';
      errorHandler?.(message);
      for (const [, p] of pending) p.reject(new Error(message));
      pending.clear();
    };
  }
  return worker;
}

export function initWorker({ onStatus, onError } = {}) {
  statusHandler = onStatus;
  errorHandler = onError;
  const w = ensureWorker();
  w.postMessage({ type: 'init' });
  return readyPromise;
}

/**
 * Process an image buffer. Resolves with
 * { imageBuffer, imageMime, debugBuffer, meta }.
 */
export function processImage(buffer, params) {
  const w = ensureWorker();
  const id = `req-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'process', id, buffer, params }, [buffer]);
  });
}

export function isWorkerReady() {
  return worker != null;
}
