import { useState } from 'react';
import type { Organ } from '@medcare/engine';
import { cx } from './ui';

export const ORGAN_LABEL: Record<Organ, string> = {
  brain: 'Brain / CNS',
  thyroid: 'Thyroid',
  heart: 'Heart',
  lungs: 'Lungs',
  liver: 'Liver',
  pancreas: 'Pancreas',
  gi: 'GI tract',
  kidneys: 'Kidneys',
  blood: 'Blood & marrow',
  muscle: 'Muscle & joints',
  skin: 'Skin',
};

// Sequential ramps (single hue, light → dark) for magnitude.
const RISK = ['#fbe3e2', '#f6b8b6', '#ef8a87', '#e34948', '#b42318', '#7a1710'];
const THER = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];

function ramp(r: string[], v: number) {
  return r[Math.min(r.length - 1, Math.max(0, Math.round(v * (r.length - 1))))];
}

export interface OrganState {
  therapeutic: number;
  risk: number;
  notes: string[];
}

/** Front-view schematic body; each organ is colored by toxicity risk (red) or therapeutic engagement (blue). */
export function BodyMap({ organs, baseline, compact }: { organs: Record<Organ, OrganState>; baseline?: Partial<Record<Organ, number>>; compact?: boolean }) {
  const [focus, setFocus] = useState<Organ | null>(null);
  const fill = (o: Organ) => {
    const s = organs[o];
    const b = baseline?.[o] ?? 0;
    const risk = Math.max(s.risk, b);
    if (risk >= 0.08) return ramp(RISK, risk);
    if (s.therapeutic >= 0.05) return ramp(THER, s.therapeutic);
    return 'var(--surface-3)';
  };
  const shape = (o: Organ, el: React.ReactNode) => (
    <g
      key={o}
      role="button"
      tabIndex={0}
      aria-label={`${ORGAN_LABEL[o]}: therapeutic engagement ${(organs[o].therapeutic * 100).toFixed(0)}%, toxicity risk ${(Math.max(organs[o].risk, baseline?.[o] ?? 0) * 100).toFixed(0)}%`}
      onMouseEnter={() => setFocus(o)}
      onFocus={() => setFocus(o)}
      onMouseLeave={() => setFocus(null)}
      onBlur={() => setFocus(null)}
      onClick={() => setFocus(o)}
      style={{ cursor: 'pointer', outline: 'none' }}
      fill={fill(o)}
      stroke={focus === o ? 'var(--fg)' : 'var(--surface)'}
      strokeWidth={focus === o ? 2 : 1.5}
    >
      {el}
    </g>
  );
  const f = focus ? organs[focus] : null;
  return (
    <div className={cx('grid gap-4', compact ? 'grid-cols-1' : 'sm:grid-cols-[minmax(180px,240px)_1fr]')}>
      <svg viewBox="0 0 200 430" className="mx-auto h-[380px] w-auto" role="group" aria-label="Organ-level effect map">
        {/* silhouette — skin (neutral backdrop unless skin is affected) */}
        <g
          role="button"
          tabIndex={0}
          aria-label={`${ORGAN_LABEL.skin}: toxicity risk ${(organs.skin.risk * 100).toFixed(0)}%`}
          onMouseEnter={() => setFocus('skin')}
          onFocus={() => setFocus('skin')}
          onMouseLeave={() => setFocus(null)}
          onBlur={() => setFocus(null)}
          style={{ outline: 'none' }}
        >
          <path
            d="M100 8c-17 0-29 13-29 30 0 13 7 24 17 28v10c-22 3-38 10-46 22-6 9-9 40-12 78-1 13-4 34-6 46l12 2c4-14 8-34 10-50l6-44v86c0 16-2 40-4 58l-6 112h24l14-150h4l14 150h24l-6-112c-2-18-4-42-4-58v-86l6 44c2 16 6 36 10 50l12-2c-2-12-5-33-6-46-3-38-6-69-12-78-8-12-24-19-46-22V66c10-4 17-15 17-28 0-17-12-30-29-30z"
            fill={organs.skin.risk >= 0.08 ? ramp(RISK, organs.skin.risk) : 'var(--surface-2)'}
            fillOpacity={organs.skin.risk >= 0.08 ? 0.45 : 1}
            stroke={focus === 'skin' ? 'var(--fg)' : 'var(--line-strong)'}
            strokeWidth={1.5}
          />
        </g>
        {shape('blood', <path opacity={0.9} d="M98 96h4v190h-4zM54 150l2-1 8 60-2 1zM146 150l-2-1-8 60 2 1z" />)}
        {shape('brain', <ellipse cx="100" cy="34" rx="21" ry="18" />)}
        {shape('thyroid', <ellipse cx="100" cy="80" rx="9" ry="4" />)}
        {shape(
          'lungs',
          <>
            <path d="M92 104c-14 0-24 14-26 34-2 18 0 34 4 38 6 2 16-2 22-8z" />
            <path d="M108 104c14 0 24 14 26 34 2 18 0 34-4 38-6 2-16-2-22-8z" />
          </>,
        )}
        {shape('heart', <path d="M104 136c6-8 18-4 16 6-2 10-14 18-18 22-6-6-14-12-14-20 0-8 10-12 16-8z" />)}
        {shape('liver', <path d="M70 186c4-10 26-12 44-8 4 2 2 8-4 12-12 8-30 12-38 8-4-2-4-8-2-12z" />)}
        {shape('gi', <><ellipse cx="122" cy="188" rx="12" ry="9" /><path d="M78 222c0-10 44-10 44 0 6 6 4 30-4 34-8 6-30 6-38 0-8-6-8-28-2-34z" /></>)}
        {shape('pancreas', <path d="M96 206c8-3 24-4 30-1 2 2 0 5-4 5-8 1-20 2-26 0-3-1-3-3 0-4z" />)}
        {shape('kidneys', <><ellipse cx="78" cy="214" rx="7" ry="11" /><ellipse cx="122" cy="214" rx="7" ry="11" /></>)}
        {shape('muscle', <><path d="M80 300h16l-2 70H82z" /><path d="M104 300h16l-2 70h-12z" /></>)}
      </svg>
      <div className="flex flex-col gap-3">
        <div aria-live="polite" className="min-h-[96px] rounded-xl border border-line bg-surface-2 p-3 text-sm">
          {focus && f ? (
            <>
              <p className="font-semibold">{ORGAN_LABEL[focus]}</p>
              <p className="mt-1 text-xs text-muted">
                Therapeutic engagement <span className="font-medium text-fg tabular">{(f.therapeutic * 100).toFixed(0)}%</span> · Toxicity risk{' '}
                <span className="font-medium text-fg tabular">{(Math.max(f.risk, baseline?.[focus] ?? 0) * 100).toFixed(0)}%</span>
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-fg-2">
                {f.notes.length ? f.notes.map((n) => <li key={n}>{n}</li>) : <li>No modelled drug effect on this organ.</li>}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted">Hover, tap or tab to an organ to see which medicines act on it and the modelled toxicity risk at the selected time.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 text-[11px] text-muted">
          <div>
            <p className="mb-1 font-medium text-fg-2">Therapeutic engagement</p>
            <div className="flex h-2 overflow-hidden rounded">{THER.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}</div>
            <div className="flex justify-between"><span>low</span><span>high</span></div>
          </div>
          <div>
            <p className="mb-1 font-medium text-fg-2">Toxicity risk</p>
            <div className="flex h-2 overflow-hidden rounded">{RISK.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}</div>
            <div className="flex justify-between"><span>low</span><span>high</span></div>
          </div>
        </div>
        {!compact && (
          <table className="w-full text-xs">
            <caption className="sr-only">Organ effect values</caption>
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-medium">Organ</th>
                <th className="py-1 text-right font-medium">Engagement</th>
                <th className="py-1 text-right font-medium">Risk</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(ORGAN_LABEL) as Organ[])
                .filter((o) => organs[o].therapeutic > 0.02 || Math.max(organs[o].risk, baseline?.[o] ?? 0) > 0.02)
                .map((o) => (
                  <tr key={o} className="border-t border-line">
                    <td className="py-1">{ORGAN_LABEL[o]}</td>
                    <td className="py-1 text-right tabular">{(organs[o].therapeutic * 100).toFixed(0)}%</td>
                    <td className={cx('py-1 text-right tabular', Math.max(organs[o].risk, baseline?.[o] ?? 0) > 0.5 && 'font-semibold text-danger')}>
                      {(Math.max(organs[o].risk, baseline?.[o] ?? 0) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
