import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pill, Activity, AlertOctagon } from 'lucide-react';
import { DRUG_CATEGORIES, DRUGS, getDrug, type Drug } from '@medcare/engine';
import { fmt, fmtHours } from '../lib/format';
import { Badge, Card, Callout, Field, PageHeader, Select } from '../components/ui';
import { SearchInput, ROUTE_LABEL } from '../components/clinical';
import { ORGAN_LABEL } from '../components/BodyMap';

function DrugDetail({ d }: { d: Drug }) {
  const t12 = (0.693 * (d.pk.Vc + (d.pk.Vp ?? 0)) * 70) / (d.pk.CL || 1);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{d.name}</h2>
          <p className="text-sm text-muted">{d.drugClass} · {d.brands.join(', ')}</p>
        </div>
        <Link to={`/app/simulate?drug=${d.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"><Activity className="size-4" aria-hidden />Simulate</Link>
      </div>
      {d.boxedWarning && <Callout tone="danger" title="Boxed warning" icon={<AlertOctagon className="mt-0.5 size-4 shrink-0" />}>{d.boxedWarning}</Callout>}
      <p className="text-sm">{d.mechanism}</p>
      <div className="flex flex-wrap gap-1.5">{d.indications.map((i) => <Badge key={i}>{i}</Badge>)}</div>
      <Card title="Pharmacokinetics (typical 70 kg adult)">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
          {[
            ['Bioavailability', `${Math.round(d.pk.F * 100)}%`],
            ['Absorption ka', d.pk.ka ? `${d.pk.ka} h⁻¹` : '—'],
            ['Clearance', d.pk.mm ? `MM: Vmax ${d.pk.mm.Vmax} mg/kg/d, Km ${d.pk.mm.Km} mg/L` : `${fmt(d.pk.CL)} L/h`],
            ['Volume', `${fmt((d.pk.Vc + (d.pk.Vp ?? 0)) * 70)} L (${d.pk.Vp ? '2-comp' : '1-comp'})`],
            ['Half-life', d.pk.mm ? 'concentration-dependent' : fmtHours(t12)],
            ['Renal excretion', `${Math.round(d.pk.fe * 100)}%`],
            ['Protein binding', `${Math.round((1 - d.pk.fu) * 100)}%`],
            ['Routes', d.routes.map((r) => ROUTE_LABEL[r]).join(', ')],
            ['Default regimen', `${d.defaultRegimen.dose} ${d.defaultRegimen.unit} q${d.defaultRegimen.intervalH}h`],
          ].map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium tabular">{v}</dd></div>)}
        </dl>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs text-muted">Metabolism</p><div className="mt-1 flex flex-wrap gap-1">{d.metabolism.length ? d.metabolism.map((m) => <Badge key={m.pathway}>{m.pathway} {Math.round(m.fm * 100)}%</Badge>) : <span className="text-sm">—</span>}</div></div>
          <div><p className="text-xs text-muted">Inhibits</p><div className="mt-1 flex flex-wrap gap-1">{d.inhibits.length ? d.inhibits.map((m) => <Badge key={m.pathway} tone="warn">{m.pathway} ({m.strength})</Badge>) : <span className="text-sm">—</span>}</div></div>
          <div><p className="text-xs text-muted">Induces</p><div className="mt-1 flex flex-wrap gap-1">{d.induces.length ? d.induces.map((m) => <Badge key={m.pathway} tone="info">{m.pathway} ({m.strength})</Badge>) : <span className="text-sm">—</span>}</div></div>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Targets & thresholds">
          <ul className="space-y-1.5 text-sm">
            <li><span className="text-muted">Therapeutic: </span>{d.therapeutic ? `${d.therapeutic.basis} ${d.therapeutic.low}–${d.therapeutic.high} ${d.therapeutic.basis === 'auc24' ? 'mg·h/L' : d.display.unit}` : '—'}</li>
            <li><span className="text-muted">Toxic: </span>{d.toxic ? `${d.toxic.basis} > ${d.toxic.value} — ${d.toxic.note}` : '—'}</li>
            <li><span className="text-muted">QT risk: </span>{d.qt.risk}</li>
            {d.cumulativeLimit && <li><span className="text-muted">Cumulative limit: </span>{d.cumulativeLimit.value} {d.cumulativeLimit.unit} — {d.cumulativeLimit.note}</li>}
          </ul>
        </Card>
        <Card title="Organ effects">
          <ul className="space-y-1.5 text-sm">{d.organs.map((o, i) => <li key={i} className="flex gap-2"><Badge tone={o.kind === 'target' ? 'info' : 'danger'}>{ORGAN_LABEL[o.organ]}</Badge><span className="text-fg-2">{o.note}</span></li>)}</ul>
        </Card>
      </div>
      <Card title="Special populations & monitoring">
        <ul className="space-y-1.5 text-sm text-fg-2">
          {d.renal && <li><strong className="text-fg">Renal: </strong>{d.renal}</li>}
          {d.hepatic && <li><strong className="text-fg">Hepatic: </strong>{d.hepatic}</li>}
          {d.pgx && <li><strong className="text-fg">Pharmacogenomics: </strong>{d.pgx}</li>}
          {d.pregnancy && <li><strong className="text-fg">Pregnancy: </strong>{d.pregnancy}</li>}
          {d.monitoring.map((m) => <li key={m}><strong className="text-fg">Monitor: </strong>{m}</li>)}
        </ul>
        {d.references.length > 0 && <p className="mt-3 text-xs text-muted">Sources: {d.references.join('; ')}</p>}
      </Card>
    </div>
  );
}

export default function Library() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const selected = params.get('drug') ?? DRUGS[0].id;
  const list = useMemo(() => DRUGS.filter((d) => (!cat || d.category === cat) && (`${d.name} ${d.brands.join(' ')} ${d.drugClass} ${d.indications.join(' ')}`.toLowerCase().includes(q.toLowerCase()))), [q, cat]);
  return (
    <div>
      <PageHeader icon={<Pill className="size-5" />} title="Drug library" description={`${DRUGS.length} medicines with population pharmacokinetics, pharmacodynamics, interaction profiles, pharmacogenomics and organ effects.`} />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-3">
          <SearchInput value={q} onChange={setQ} placeholder="Search name, class, indication…" label="Search drugs" />
          <Field label="Category" htmlFor="cat">
            <Select id="cat" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{DRUG_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
          <ul className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto rounded-2xl border border-line bg-surface p-2" aria-label="Drugs">
            {list.map((d) => (
              <li key={d.id}>
                <button onClick={() => setParams({ drug: d.id })} aria-current={selected === d.id} className={`w-full rounded-lg px-3 py-2 text-left ${selected === d.id ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2'}`}>
                  <span className="block text-sm font-medium">{d.name}</span>
                  <span className="block text-xs text-muted">{d.drugClass}</span>
                </button>
              </li>
            ))}
            {!list.length && <li className="p-3 text-sm text-muted">No matches</li>}
          </ul>
        </div>
        <DrugDetail d={getDrug(DRUGS.some((d) => d.id === selected) ? selected : DRUGS[0].id)} />
      </div>
    </div>
  );
}
