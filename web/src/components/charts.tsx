import { useMemo } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmt, timeLabel } from '../lib/format';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  dash?: string;
  width?: number;
}

interface TimeChartProps {
  t: number[];
  series: { def: SeriesDef; values: number[] }[];
  unit: string;
  height?: number;
  band?: { low: number; high: number; label: string };
  toxic?: { value: number; label: string };
  cursorH?: number;
  observations?: { t: number; v: number }[];
  ariaLabel: string;
  yDomain?: [number | 'auto', number | 'auto'];
  refLines?: { y: number; label: string }[];
}

function niceTicks(span: number): number[] {
  const steps = [1, 2, 4, 6, 12, 24, 48, 72, 168, 336, 720, 1440, 2160];
  const step = steps.find((s) => span / s <= 8) ?? 4320;
  const out: number[] = [];
  for (let x = 0; x <= span + 1e-9; x += step) out.push(x);
  return out;
}

/** Concentration/effect vs time with crosshair tooltip, therapeutic window and toxic threshold. */
export function TimeChart({ t, series, unit, height = 260, band, toxic, cursorH, observations, ariaLabel, yDomain, refLines }: TimeChartProps) {
  const data = useMemo(
    () =>
      t.map((x, i) => {
        const row: Record<string, number> = { t: x };
        for (const s of series) row[s.def.key] = s.values[i];
        return row;
      }),
    [t, series],
  );
  const span = t[t.length - 1] ?? 24;
  const ticks = niceTicks(span);
  const obsData = observations?.map((o) => ({ t: o.t, obs: o.v }));
  return (
    <figure aria-label={ariaLabel} className="w-full">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="0" />
            <XAxis dataKey="t" type="number" domain={[0, span]} ticks={ticks} tickFormatter={(v) => timeLabel(v, span)} stroke="var(--line-strong)" tickLine={false} />
            <YAxis
              stroke="var(--line-strong)"
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v) => fmt(v, 2)}
              domain={yDomain ?? [0, 'auto']}
              label={{ value: unit, angle: -90, position: 'insideLeft', offset: 12 }}
            />
            {band && <ReferenceArea y1={band.low} y2={band.high} fill="var(--band)" stroke="none" ifOverflow="extendDomain" label={{ value: band.label, position: 'insideTopRight', fill: 'var(--band-line)', fontSize: 10 }} />}
            {toxic && <ReferenceLine y={toxic.value} stroke="var(--toxic-line)" strokeDasharray="5 4" ifOverflow="extendDomain" label={{ value: toxic.label, position: 'insideBottomRight', fill: 'var(--toxic-line)', fontSize: 10 }} />}
            {refLines?.map((r) => <ReferenceLine key={r.label} y={r.y} stroke="var(--muted)" strokeDasharray="3 3" label={{ value: r.label, position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 10 }} />)}
            {cursorH !== undefined && <ReferenceLine x={cursorH} stroke="var(--fg)" strokeOpacity={0.5} />}
            <Tooltip
              cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--fg)' }}
              labelFormatter={(v) => `t = ${fmt(Number(v))} h (${(Number(v) / 24).toFixed(1)} d)`}
              formatter={(v, name) => [`${fmt(Number(v))} ${unit}`, String(name)]}
            />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: 'var(--fg-2)' }} iconType="plainline" />}
            {series.map((s) => (
              <Line key={s.def.key} dataKey={s.def.key} name={s.def.label} type="monotone" stroke={s.def.color} strokeWidth={s.def.width ?? 2} strokeDasharray={s.def.dash} dot={false} isAnimationActive={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
            ))}
            {obsData && <Line data={obsData} dataKey="obs" name="Measured level" stroke="none" isAnimationActive={false} dot={{ r: 5, fill: 'var(--s2)', stroke: 'var(--surface)', strokeWidth: 2 }} legendType="circle" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Population percentile bands (5–95 and 25–75) with median line. */
export function BandChart({ t, p5, p25, p50, p75, p95, unit, color, band, toxic, height = 280, label }: {
  t: number[]; p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[]; unit: string; color: string;
  band?: { low: number; high: number }; toxic?: number; height?: number; label: string;
}) {
  const data = t.map((x, i) => ({ t: x, outer: [p5[i], p95[i]], inner: [p25[i], p75[i]], median: p50[i] }));
  const span = t[t.length - 1] ?? 24;
  return (
    <figure aria-label={label} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" domain={[0, span]} ticks={niceTicks(span)} tickFormatter={(v) => timeLabel(v, span)} stroke="var(--line-strong)" tickLine={false} />
          <YAxis stroke="var(--line-strong)" tickLine={false} axisLine={false} width={52} tickFormatter={(v) => fmt(v, 2)} label={{ value: unit, angle: -90, position: 'insideLeft', offset: 12 }} />
          {band && <ReferenceArea y1={band.low} y2={band.high} fill="var(--band)" stroke="none" ifOverflow="extendDomain" />}
          {toxic !== undefined && <ReferenceLine y={toxic} stroke="var(--toxic-line)" strokeDasharray="5 4" ifOverflow="extendDomain" />}
          <Tooltip
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--fg)' }}
            labelFormatter={(v) => `t = ${fmt(Number(v))} h`}
            formatter={(v, name) => [Array.isArray(v) ? `${fmt(Number(v[0]))} – ${fmt(Number(v[1]))} ${unit}` : `${fmt(Number(v))} ${unit}`, String(name)]}
          />
          <Area dataKey="outer" name="5th–95th percentile" stroke="none" fill={color} fillOpacity={0.15} isAnimationActive={false} />
          <Area dataKey="inner" name="25th–75th percentile" stroke="none" fill={color} fillOpacity={0.3} isAnimationActive={false} />
          <Line dataKey="median" name="Median" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </figure>
  );
}

/** Histogram of a per-subject metric with target window shading. */
export function Histogram({ values, unit, low, high, toxic, color, label }: { values: number[]; unit: string; low?: number; high?: number; toxic?: number; color: string; label: string }) {
  const bins = useMemo(() => {
    if (!values.length) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = sorted[Math.ceil(sorted.length * 0.99) - 1];
    const n = 24;
    const w = (hi - lo) / n || 1;
    const out = Array.from({ length: n }, (_, i) => ({ x: lo + (i + 0.5) * w, from: lo + i * w, to: lo + (i + 1) * w, count: 0 }));
    for (const v of values) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((v - lo) / w)));
      out[i].count++;
    }
    return out;
  }, [values]);
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <figure aria-label={label}>
      <div className="flex h-36 items-end gap-[2px]" role="img" aria-label={`${label}: distribution of ${values.length} subjects`}>
        {bins.map((b, i) => {
          const inRange = low !== undefined && high !== undefined && b.x >= low && b.x <= high;
          const tox = toxic !== undefined && b.x > toxic;
          return (
            <div key={i} className="group relative flex-1">
              <div
                className="w-full rounded-t-[4px]"
                style={{ height: `${(b.count / max) * 130}px`, background: tox ? 'var(--s8)' : inRange ? color : 'var(--line-strong)' }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-[11px] shadow group-hover:block">
                {fmt(b.from)}–{fmt(b.to)} {unit}: {b.count}
              </div>
            </div>
          );
        })}
      </div>
      <figcaption className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-muted">
        <span>{bins[0] ? fmt(bins[0].from) : ''} {unit}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm" style={{ background: color }} /> In target</span>
          <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-[var(--line-strong)]" /> Outside</span>
          {toxic !== undefined && <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-[var(--s8)]" /> Toxic</span>}
        </span>
        <span>{bins.length ? fmt(bins[bins.length - 1].to) : ''} {unit}</span>
      </figcaption>
    </figure>
  );
}
