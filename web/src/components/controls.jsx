import { useEffect, useRef, useState } from 'react';

// Track whether Shift is currently held, so sliders/number inputs can make
// coarser (×10) jumps while holding Shift.
function useShiftHeld() {
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Shift') setShift(true);
    };
    const up = (e) => {
      if (e.key === 'Shift') setShift(false);
    };
    const blur = () => setShift(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return shift;
}

// A small "?" that shows an immediate, custom hover tooltip. It's rendered
// position:fixed so the sidebar's scroll container can't clip it.
function HelpIcon({ text }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  if (!text) return null;

  const onEnter = () => {
    const r = ref.current.getBoundingClientRect();
    const width = 260;
    const x = Math.max(8, Math.min(r.right + 8, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 140));
    setPos({ x, y });
  };

  return (
    <span
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={() => setPos(null)}
      className="w-4 h-4 text-[10px] leading-none rounded-full bg-neutral-700 text-neutral-300 hover:bg-neutral-500 hover:text-white flex items-center justify-center shrink-0 cursor-help select-none"
    >
      ?
      {pos && (
        <span
          className="fixed z-50 w-[260px] bg-neutral-800 border border-neutral-700 rounded-md px-2.5 py-2 text-[11px] font-normal text-neutral-200 leading-snug shadow-xl pointer-events-none"
          style={{ left: pos.x, top: pos.y }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

export function NumberControl({ label, value, min, max, step, unit, onChange, help, disabled }) {
  const shift = useShiftHeld();
  const s = shift ? step * 10 : step;

  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[13px] text-neutral-400">
          {label}
          <HelpIcon text={help} />
        </span>
        <span className="flex items-baseline gap-1 tabular-nums">
          <input
            type="number"
            value={value ?? ''}
            min={min}
            max={max}
            step={s}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            className="w-20 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-right text-xs text-neutral-200 focus:outline-none focus:border-amber-400 disabled:text-neutral-500"
          />
          {unit && <span className="text-[11px] text-neutral-500">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={s}
        value={value ?? min}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-1 disabled:opacity-40"
      />
    </div>
  );
}

export function Toggle({ label, checked, onChange, help }) {
  return (
    <button
      type="button"
      title={help}
      onClick={() => onChange(!checked)}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-[13px] ${
        checked ? 'bg-amber-400/10 text-amber-300' : 'bg-neutral-800 text-neutral-300'
      }`}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${
          checked ? 'bg-amber-400' : 'bg-neutral-600'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-black transition ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

const SEED_HELP =
  'A seed is the starting number for the random details: edge roughness, corner ' +
  'rounding, which corners are squared off, whether a sprocket sliver shows, and ' +
  'the border shift. Same seed + same settings = an identical result every time. ' +
  'Empty (random) = a fresh roll of the dice on each run. Set a number to freeze ' +
  'a look you like.';

export function SeedControl({ value, onChange, disabled }) {
  const shift = useShiftHeld();
  const step = shift ? 10 : 1;

  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[13px] text-neutral-400">
          Seed
          <HelpIcon text={SEED_HELP} />
        </span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            value={value ?? ''}
            placeholder="random"
            step={step}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            className="w-20 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-right text-xs text-neutral-200 focus:outline-none focus:border-amber-400 disabled:text-neutral-500"
          />
          <button
            type="button"
            title="Randomize seed"
            disabled={disabled}
            onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}
            className="min-w-[26px] h-[26px] bg-neutral-800 hover:bg-neutral-700 text-sm rounded-full flex items-center justify-center disabled:opacity-40"
          >
            🎲
          </button>
        </span>
      </div>
      <div className="text-[11px] text-neutral-500 mt-0.5">
        Empty = random every time (like omitting --seed)
      </div>
    </div>
  );
}

export function SelectControl({ label, value, options, onChange, help, disabled }) {
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <span className="flex items-center gap-1 text-[13px] text-neutral-400">
        {label}
        <HelpIcon text={help} />
      </span>
      <div className="flex gap-1 mt-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`flex-1 px-2 h-8 text-xs rounded flex items-center justify-center ${
              value === o.value
                ? 'bg-white text-black'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Section({ title, children, action }) {
  return (
    <div className="px-3 py-2.5 border-b app-border">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-widest text-neutral-500">{title}</h3>
        {action}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}
