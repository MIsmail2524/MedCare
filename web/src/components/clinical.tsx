import { useMemo, useRef, useState } from 'react';
import { Plus, Trash2, ChevronDown } from 'lucide-react';
import { DRUG_CATEGORIES, DRUGS, getDrug, makeRegimen, type Alert, type Regimen, type Route } from '@medcare/engine';
import { Badge, Button, Field, Input, NumberField, Select, SeverityBadge, cx } from './ui';
import type { Twin } from '../lib/twins';

export const ROUTE_LABEL: Record<Route, string> = { po: 'Oral', iv_bolus: 'IV bolus', iv_infusion: 'IV infusion', sc: 'Subcutaneous' };
const INTERVALS = [1, 2, 4, 6, 8, 12, 24, 48, 72, 168, 504];

export function DrugSelect({ value, onChange, id, exclude = [] }: { value: string; onChange: (id: string) => void; id?: string; exclude?: string[] }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {DRUG_CATEGORIES.map((c) => (
        <optgroup key={c} label={c}>
          {DRUGS.filter((d) => d.category === c && (!exclude.includes(d.id) || d.id === value)).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function RegimenRow({ r, onChange, onRemove, index, colorVar }: { r: Regimen; onChange: (r: Regimen) => void; onRemove: () => void; index: number; colorVar: string }) {
  const d = getDrug(r.drugId);
  const [open, setOpen] = useState(index === 0);
  const days = (r.doses * r.intervalH) / 24;
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorVar }} aria-hidden />
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="truncate text-sm font-medium">{d.name}</span>
          <span className="truncate text-xs text-muted tabular">
            {r.dose} {r.unit} {ROUTE_LABEL[r.route]} q{r.intervalH}h × {r.doses}
          </span>
          <ChevronDown className={cx('ml-auto size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        <button onClick={onRemove} className="rounded-md p-1 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove ${d.name}`}>
          <Trash2 className="size-4" />
        </button>
      </div>
      {open && (
        <div className="grid grid-cols-2 gap-3 border-t border-line p-3">
          <div className="col-span-2">
            <Field label="Medicine" htmlFor={`drug-${r.id}`}>
              <DrugSelect
                id={`drug-${r.id}`}
                value={r.drugId}
                onChange={(id) => {
                  const n = makeRegimen(id, { id: r.id, startH: r.startH });
                  onChange({ ...n, doses: Math.max(1, Math.round((days * 24) / n.intervalH)) });
                }}
              />
            </Field>
          </div>
          <Field label="Route" htmlFor={`route-${r.id}`}>
            <Select id={`route-${r.id}`} value={r.route} onChange={(e) => onChange({ ...r, route: e.target.value as Route, infusionH: e.target.value === 'iv_infusion' ? r.infusionH ?? 1 : undefined })}>
              {d.routes.map((x) => (
                <option key={x} value={x}>
                  {ROUTE_LABEL[x]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dose unit" htmlFor={`unit-${r.id}`}>
            <Select id={`unit-${r.id}`} value={r.unit} onChange={(e) => onChange({ ...r, unit: e.target.value as Regimen['unit'] })}>
              <option value="mg">mg</option>
              <option value="mg/kg">mg/kg</option>
              <option value="mg/m2">mg/m²</option>
            </Select>
          </Field>
          <NumberField label="Dose" value={r.dose} min={0.001} max={100000} unit={r.unit === 'mg/m2' ? 'mg/m²' : r.unit} onChange={(v) => onChange({ ...r, dose: v })} />
          <Field label="Interval" htmlFor={`int-${r.id}`}>
            <Select
              id={`int-${r.id}`}
              value={r.intervalH}
              onChange={(e) => {
                const iv = Number(e.target.value);
                onChange({ ...r, intervalH: iv, doses: Math.max(1, Math.round((days * 24) / iv)) });
              }}
            >
              {Array.from(new Set([...INTERVALS, r.intervalH])).sort((a, b) => a - b).map((i) => (
                <option key={i} value={i}>
                  {i < 24 ? `every ${i} h` : i === 24 ? 'daily' : i === 168 ? 'weekly' : i === 504 ? 'every 3 weeks' : `every ${i / 24} d`}
                </option>
              ))}
            </Select>
          </Field>
          <NumberField label="Number of doses" value={r.doses} min={1} max={2000} step={1} hint={`≈ ${days.toFixed(days < 2 ? 1 : 0)} days`} onChange={(v) => onChange({ ...r, doses: Math.round(v) })} />
          <NumberField label="Start at" value={r.startH} min={0} max={8760} unit="h" onChange={(v) => onChange({ ...r, startH: v })} info="Delay from simulation start — e.g. start an interacting drug on day 7 (168 h)." />
          {r.route === 'iv_infusion' && <NumberField label="Infusion duration" value={r.infusionH ?? 1} min={0.02} max={72} unit="h" onChange={(v) => onChange({ ...r, infusionH: v })} />}
          <NumberField label="Loading dose (optional)" value={r.loadingDose ?? 0} min={0} max={100000} unit={r.unit} onChange={(v) => onChange({ ...r, loadingDose: v > 0 ? v : undefined })} hint="0 = none" />
        </div>
      )}
    </div>
  );
}

export function RegimenEditor({ regimens, onChange, colors, max = 6 }: { regimens: Regimen[]; onChange: (r: Regimen[]) => void; colors: (drugId: string) => string; max?: number }) {
  const [adding, setAdding] = useState('');
  const used = regimens.map((r) => r.drugId);
  const available = DRUGS.filter((d) => !used.includes(d.id));
  return (
    <div className="flex flex-col gap-2">
      {regimens.map((r, i) => (
        <RegimenRow
          key={r.id}
          r={r}
          index={i}
          colorVar={colors(r.drugId)}
          onChange={(n) => onChange(regimens.map((x) => (x.id === r.id ? n : x)))}
          onRemove={() => onChange(regimens.filter((x) => x.id !== r.id))}
        />
      ))}
      {regimens.length < max && (
        <div className="flex gap-2">
          <Select aria-label="Add medicine" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a medicine…</option>
            {DRUG_CATEGORIES.map((c) => (
              <optgroup key={c} label={c}>
                {available.filter((d) => d.category === c).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Button
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={!adding}
            onClick={() => {
              const longest = Math.max(168, ...regimens.map((r) => r.startH + r.doses * r.intervalH));
              const n = makeRegimen(adding);
              onChange([...regimens, { ...n, doses: Math.max(1, Math.round(longest / n.intervalH)) }]);
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export function AlertList({ alerts, empty = 'No interaction, pharmacogenomic or exposure alerts.' }: { alerts: Alert[]; empty?: string }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? alerts : alerts.slice(0, 6);
  if (!alerts.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label="Clinical alerts">
      {shown.map((a, i) => (
        <li key={i} className={cx('rounded-xl border p-3', a.severity === 'contraindicated' || a.severity === 'major' ? 'border-danger/30 bg-danger-soft/40' : 'border-line bg-surface')}>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={a.severity} />
            <Badge>{a.category}</Badge>
            <p className="text-sm font-semibold">{a.title}</p>
          </div>
          <p className="mt-1 text-sm text-fg-2">{a.detail}</p>
          {a.action && (
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium text-fg-2">Action: </span>
              {a.action}
            </p>
          )}
        </li>
      ))}
      {alerts.length > 6 && (
        <li>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Show fewer' : `Show all ${alerts.length} alerts`}
          </Button>
        </li>
      )}
    </ul>
  );
}

export function TwinPicker({ twins, value, onChange, id }: { twins: Twin[] | null; value: string; onChange: (id: string) => void; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!twins}>
      <option value="">Reference adult (40 y, 70 kg, normal function)</option>
      {twins?.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </Select>
  );
}

export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />;
}

/** Sticky colour assignment: a drug keeps its slot while present, so removing one never repaints others. */
export function useDrugColors(ids: string[]) {
  const ref = useRef(new Map<string, number>());
  const key = ids.join('|');
  return useMemo(() => {
    const m = ref.current;
    for (const id of Array.from(m.keys())) if (!ids.includes(id)) m.delete(id);
    for (const id of ids) {
      if (m.has(id)) continue;
      const usedSlots = new Set(m.values());
      let slot = 0;
      while (usedSlots.has(slot) && slot < 7) slot++;
      m.set(id, slot);
    }
    return (id: string) => `var(--s${(m.get(id) ?? 0) + 1})`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
