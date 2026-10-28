import { useEffect, useMemo, useState } from 'react';
import { Landmark, Printer, FlaskConical, CheckCircle2, XCircle, AlertTriangle, Atom, Loader2 } from 'lucide-react';
import {
  base64ToBytes, bitsToBase64, buildDossier, candidateToDrug, DRUGS, DRUG_MAP, predictLiabilities, SAFETY_ORGANS,
  type Dossier, type KBDrug, type Pathway, type PredictionResult, type SafetyKB,
} from '@medcare/engine';
import { useSafetyKB, parseSmiles, ORGAN_NAMES, type ParsedMolecule } from '../lib/safety';
import { useToast } from '../lib/toast';
import { fmt } from '../lib/format';
import { Badge, Button, Callout, Card, Field, Input, NumberField, PageHeader, Select, Skeleton, Stat, Tabs, cx } from '../components/ui';
import { SearchInput } from '../components/clinical';

const PATHWAYS: Pathway[] = ['CYP3A4', 'CYP2D6', 'CYP2C9', 'CYP2C19', 'CYP1A2', 'CYP2B6', 'UGT'];

const EXAMPLES = [
  {
    id: 'quinolone', label: 'Fluoroquinolone analogue', smiles: 'O=C(O)C1=CN(C2CC2)c2cc(N3CCNC(C)C3)c(F)cc2C1=O', classes: ['Quinolone Antimicrobial'],
    pk: { CL: 22, V: 180, F: 0.75, ka: 1.4, fe: 0.45, fu: 0.7, dose: 400, intervalH: 12, targetLow: 0.6, targetHigh: 3, toxicConc: 8, metabolism: [{ pathway: 'CYP1A2' as Pathway, fm: 0.2 }] },
  },
  {
    id: 'statin', label: 'HMG-CoA reductase inhibitor analogue', smiles: 'CC(C)c1c(C(=O)Nc2ccccc2)c(-c2ccccc2)c(-c2ccc(F)cc2)n1CC[C@@H](O)C[C@@H](O)CC(=O)O', classes: ['HMG-CoA Reductase Inhibitor'],
    pk: { CL: 40, V: 350, F: 0.15, ka: 0.8, fe: 0.02, fu: 0.03, dose: 40, intervalH: 24, targetLow: 0.001, targetHigh: 0.02, toxicConc: 0.05, metabolism: [{ pathway: 'CYP3A4' as Pathway, fm: 0.85 }] },
  },
  {
    id: 'novel', label: 'Novel scaffold (no close analogues)', smiles: 'CC(C)Oc1ccc(cc1)C(=O)N1CCC(CC1)n1cnc2ccccc21', classes: [] as string[],
    pk: { CL: 15, V: 120, F: 0.5, ka: 1, fe: 0.1, fu: 0.1, dose: 100, intervalH: 24, targetLow: 0.2, targetHigh: 1, toxicConc: 4, metabolism: [{ pathway: 'CYP3A4' as Pathway, fm: 0.5 }, { pathway: 'CYP2D6' as Pathway, fm: 0.3 }] },
  },
];

/** Use the real FDA label as the liability profile for an approved drug. */
function labelAsPrediction(d: KBDrug): PredictionResult {
  return {
    liabilities: SAFETY_ORGANS.map((o) => ({
      organ: o,
      probability: d.organs[o].label === 2 ? 0.9 : d.organs[o].label === 1 ? 0.7 : d.organs[o].prr >= 3 && d.organs[o].count >= 50 ? 0.3 : 0.05,
      support: 1,
      boxedLikely: d.organs[o].label === 2,
      evidence: [],
    })).sort((a, b) => b.probability - a.probability),
    neighbours: [],
    applicability: { maxSimilarity: 1, inDomain: true, note: 'Approved drug — FDA label used as the liability profile.' },
  };
}

function LiabilityBars({ pred, actual }: { pred: PredictionResult; actual?: KBDrug }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {pred.liabilities.map((l) => {
        const lab = actual?.organs[l.organ].label ?? null;
        const predicted = l.probability >= 0.35;
        const hit = lab === null ? null : predicted === lab > 0;
        return (
          <li key={l.organ}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                {ORGAN_NAMES[l.organ]}
                {l.boxedLikely && <Badge tone="danger">boxed-class risk</Badge>}
              </span>
              <span className="flex items-center gap-2 text-xs tabular">
                {Math.round(l.probability * 100)}%
                {lab !== null && (
                  <Badge tone={hit ? 'ok' : 'warn'}>
                    {hit ? <CheckCircle2 className="size-3" aria-hidden /> : <XCircle className="size-3" aria-hidden />}
                    label: {lab === 2 ? 'boxed' : lab === 1 ? 'warning' : 'none'}
                  </Badge>
                )}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-surface-3" role="meter" aria-label={`${ORGAN_NAMES[l.organ]} liability`} aria-valuenow={Math.round(l.probability * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx('h-full rounded', l.probability >= 0.6 ? 'bg-danger' : l.probability >= 0.35 ? 'bg-warn' : 'bg-[var(--s1)]')} style={{ width: `${l.probability * 100}%` }} />
            </div>
            {l.evidence.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted">
                Evidence: {l.evidence.map((e) => `${e.drug} (sim ${e.similarity.toFixed(2)}${e.label ? `, ${e.label === 2 ? 'boxed' : 'labelled'}` : ''}${e.prr >= 2 ? `, FAERS PRR ${e.prr.toFixed(1)}` : ''})`).join(' · ')}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DossierView({ d, pred, kb }: { d: Dossier; pred: PredictionResult; kb: SafetyKB }) {
  const organs = d.organRisk.filter((r) => r.probability >= 0.2).slice(0, 6);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Virtual target attainment" value={d.benefitRisk.pta !== null ? `${Math.round(d.benefitRisk.pta * 100)}%` : '—'} tone={d.benefitRisk.pta !== null && d.benefitRisk.pta >= 0.6 ? 'ok' : 'warn'} />
        <Stat label="Exceeds toxicity threshold" value={d.benefitRisk.pToxic !== null ? `${Math.round(d.benefitRisk.pToxic * 100)}%` : '—'} tone={(d.benefitRisk.pToxic ?? 0) > 0.1 ? 'danger' : undefined} />
        <Stat label="Proposed label warnings" value={d.label.warnings.length} sub={d.label.boxedWarning.length ? `${d.label.boxedWarning.length} boxed` : 'no boxed warning'} tone={d.label.boxedWarning.length ? 'danger' : undefined} />
        <Stat label="Reviewer questions" value={d.reviewerQuestions.length} />
      </div>
      <Callout tone="info" title="Benefit–risk summary">{d.benefitRisk.summary}</Callout>
      <div className="grid gap-4 2xl:grid-cols-2">
        <Card title="Exposure in special populations" subtitle="Simulated AUC relative to a reference adult (same dose)">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-2 font-medium">Subgroup</th>
                  <th className="pb-2 font-medium">AUC</th>
                  <th className="pb-2 font-medium">Cmax</th>
                  <th className="pb-2 font-medium">Status</th>
                  {organs.slice(0, 3).map((o) => <th key={o.organ} className="pb-2 font-medium">{ORGAN_NAMES[o.organ]} risk</th>)}
                </tr>
              </thead>
              <tbody>
                {d.exposure.map((e) => (
                  <tr key={e.id} className="border-t border-line tabular">
                    <td className="py-1.5 pr-2">{e.label}</td>
                    <td className={cx('py-1.5', e.aucRatio >= 1.5 ? 'font-semibold text-danger' : e.aucRatio <= 0.67 ? 'font-semibold text-info' : '')}>{e.aucRatio.toFixed(2)}×</td>
                    <td>{e.cmaxRatio.toFixed(2)}×</td>
                    <td><Badge tone={e.status === 'toxic' ? 'danger' : e.status === 'within' ? 'ok' : 'warn'}>{e.status}</Badge></td>
                    {organs.slice(0, 3).map((o) => {
                      const v = o.rows.find((r) => r.id === e.id)?.index ?? 0;
                      return <td key={o.organ} className={cx(v >= 0.6 ? 'text-danger font-semibold' : v >= 0.35 ? 'text-warn' : '')}>{Math.round(v * 100)}%</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted">Risk index = 1 − (1 − p)^(AUC ratio^0.8): organ liability scaled by simulated exposure — a relative index, not an incidence.</p>
        </Card>
        <Card title="Draft label (twin-generated)" subtitle="For reviewer comparison with the sponsor’s proposed label">
          <div className="space-y-3 text-sm">
            {d.label.boxedWarning.length > 0 && (
              <div className="rounded-lg border-2 border-danger p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-danger">Boxed warning</p>
                <ul className="mt-1 list-disc pl-4">{d.label.boxedWarning.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            )}
            {[
              ['Warnings and precautions', d.label.warnings.map((w) => w.text)],
              ['Dosage adjustments', d.label.dosing],
              ['Drug interactions', d.label.interactions.length ? d.label.interactions : ['No clinically significant CYP-mediated interactions predicted with index perpetrators.']],
              ['Use in specific populations', d.label.specificPopulations],
              ['Monitoring', d.label.monitoring],
            ].filter(([, items]) => (items as string[]).length).map(([title, items]) => (
              <div key={title as string}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title as string}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg-2">{(items as string[]).map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title={<span className="flex items-center gap-2"><AlertTriangle className="size-4 text-warn" aria-hidden />Reviewer questions & evidence gaps</span>}>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-2">{d.reviewerQuestions.map((q) => <li key={q}>{q}</li>)}</ol>
      </Card>
      <Card title="Model credibility" subtitle="How much to trust the liability layer (ASME V&V 40-style context of use)">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="text-sm text-fg-2">
            <p><strong className="text-fg">Applicability domain: </strong>{pred.applicability.note}</p>
            {kb.validation && <p className="mt-2"><strong className="text-fg">Validation: </strong>leave-one-drug-out on {kb.validation.n} FDA-labelled drugs, macro AUROC {kb.validation.macroAuroc.toFixed(2)}. {kb.validation.method}</p>}
          </div>
          {kb.validation && (
            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              {kb.validation.organs.map((m) => (
                <div key={m.organ} className={cx('rounded-md p-1.5', m.auroc >= 0.75 ? 'bg-ok-soft' : m.auroc >= 0.65 ? 'bg-warn-soft' : 'bg-surface-2')}>
                  <p className="font-medium">{ORGAN_NAMES[m.organ]}</p>
                  <p className="tabular">AUROC {Number.isFinite(m.auroc) ? m.auroc.toFixed(2) : '—'} · n+ {m.positives}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function Regulatory() {
  const { kb, error } = useSafetyKB();
  const toast = useToast();
  const [mode, setMode] = useState<'approved' | 'new'>('approved');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState('amiodarone');
  // new molecule
  const [ex, setEx] = useState(EXAMPLES[0]);
  const [name, setName] = useState('MC-101 (quinolone analogue)');
  const [smiles, setSmiles] = useState(EXAMPLES[0].smiles);
  const [classes, setClasses] = useState<string[]>(EXAMPLES[0].classes);
  const [pk, setPk] = useState(EXAMPLES[0].pk);
  const [mol, setMol] = useState<ParsedMolecule | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ dossier: Dossier; pred: PredictionResult } | null>(null);

  const allClasses = useMemo(() => Array.from(new Set(kb?.drugs.flatMap((d) => d.classes) ?? [])).sort(), [kb]);
  const kbDrug = kb ? kb.drugs.find((d) => d.name === selected) : undefined;
  const blind = useMemo(() => (kb && kbDrug ? predictLiabilities({ fp: kbDrug.fp ? base64ToBytes(kbDrug.fp) : null, classes: kbDrug.classes }, kb, { exclude: kbDrug.name }) : null), [kb, kbDrug]);
  const pkDrug = kbDrug ? DRUGS.find((d) => d.id === kbDrug.name || d.name.toLowerCase().startsWith(kbDrug.name) || kbDrug.name.startsWith(d.id)) : undefined;
  const approvedDossier = useMemo(() => (kbDrug && pkDrug ? buildDossier(pkDrug, labelAsPrediction(kbDrug), { trialN: 80 }) : null), [kbDrug, pkDrug]);
  const accuracy = useMemo(() => {
    if (!blind || !kbDrug) return null;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const l of blind.liabilities) {
      const y = kbDrug.organs[l.organ].label > 0;
      const p = l.probability >= 0.35;
      if (p && y) tp++;
      else if (p && !y) fp++;
      else if (!p && y) fn++;
      else tn++;
    }
    return { tp, fp, fn, tn };
  }, [blind, kbDrug]);

  useEffect(() => {
    if (mode !== 'new') return;
    let live = true;
    const t = setTimeout(() => parseSmiles(smiles).then((m) => live && setMol(m)).catch((e) => live && setMol({ valid: false, error: `Structure engine failed to load: ${(e as Error).message}` })), 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [smiles, mode]);

  const runNew = async () => {
    if (!kb) return;
    setBusy(true);
    try {
      const m = await parseSmiles(smiles);
      if (!m.valid) throw new Error('Invalid SMILES — check the structure.');
      const fpBytes = base64ToBytes(bitsToBase64(m.fpBits!));
      const pred = predictLiabilities({ fp: fpBytes, classes }, kb);
      const drug = candidateToDrug({ name, classes, smiles, ...pk, route: 'po' }, pred);
      await new Promise((r) => setTimeout(r, 10));
      const dossier = buildDossier(drug, pred, { trialN: 100 });
      setResult({ dossier, pred });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Callout tone="danger" title="Knowledge base unavailable">{error}. Run <code>node tools/build-safety-kb.mjs</code>.</Callout>;
  const list = (kb?.drugs ?? []).filter((d) => `${d.genericName} ${d.brands.join(' ')} ${d.classes.join(' ')}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader
        icon={<Landmark className="size-5" />}
        title="Regulatory twin"
        description="An in-silico safety review that fuses organ liabilities learned from FDA labels and FAERS with mechanistic exposure in virtual special populations — producing a draft label, interaction table and the evidence gaps a regulator should query. Aligned with the FDA’s 2025 roadmap for new approach methodologies (NAMs)."
        actions={<Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print dossier</Button>}
      />
      <div className="mb-5"><Tabs label="Review mode" value={mode} onChange={setMode} tabs={[{ id: 'approved', label: 'Approved medicine (retrospective)' }, { id: 'new', label: 'New molecule (prospective)', icon: <Atom className="size-4" /> }]} /></div>
      {!kb ? <Skeleton className="h-96" /> : mode === 'approved' ? (
        <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
          <div className="flex flex-col gap-3 print:hidden">
            <SearchInput value={q} onChange={setQ} placeholder={`Search ${kb.drugs.length} labelled medicines…`} label="Search medicines" />
            <ul className="flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto rounded-2xl border border-line bg-surface p-2">
              {list.map((d) => (
                <li key={d.name}>
                  <button onClick={() => setSelected(d.name)} aria-current={selected === d.name} className={cx('w-full rounded-lg px-3 py-1.5 text-left', selected === d.name ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2')}>
                    <span className="block text-sm font-medium">{d.genericName}</span>
                    <span className="block truncate text-[11px] text-muted">{d.classes[0] ?? '—'}{d.boxed ? ' · boxed warning' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {kbDrug && blind && (
            <div className="flex min-w-0 flex-col gap-4">
              <div className="grid gap-4 2xl:grid-cols-2">
                <Card title={`Blind twin prediction vs. FDA label — ${kbDrug.genericName}`} subtitle="Predicted from structural & pharmacological analogues with this drug held out, then compared with its actual label">
                  {accuracy && <p className="mb-3 text-sm"><Badge tone="ok">{accuracy.tp} correct warnings</Badge> <Badge tone="warn">{accuracy.fn} missed</Badge> <Badge>{accuracy.fp} extra</Badge> <Badge>{accuracy.tn} correct negatives</Badge></p>}
                  <LiabilityBars pred={blind} actual={kbDrug} />
                </Card>
                <Card title="Post-market evidence (FAERS)" subtitle={`${kbDrug.faersTotal.toLocaleString()} reports as primary suspect · disproportionality vs. ${kb.drugs.length} reference drugs`}>
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Organ</th><th className="pb-1 font-medium">PRR</th><th className="pb-1 font-medium">Reports</th><th className="pb-1 font-medium">Label</th></tr></thead>
                    <tbody>
                      {SAFETY_ORGANS.map((o) => kbDrug.organs[o]).map((x, i) => ({ x, o: SAFETY_ORGANS[i] })).sort((a, b) => b.x.prr - a.x.prr).map(({ x, o }) => (
                        <tr key={o} className="border-t border-line tabular">
                          <td className="py-1.5">{ORGAN_NAMES[o]}</td>
                          <td className={cx(x.prr >= 2 && x.count >= 25 ? 'font-semibold text-danger' : '')}>{x.prr > 50 ? '> 50' : x.prr.toFixed(2)}</td>
                          <td>{x.count.toLocaleString()}</td>
                          <td>{x.label === 2 ? <Badge tone="danger">boxed</Badge> : x.label === 1 ? <Badge tone="warn">warning</Badge> : x.prr >= 2 && x.count >= 25 ? <Badge tone="info">unlabelled signal</Badge> : <span className="text-xs text-muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {SAFETY_ORGANS.filter((o) => kbDrug.organs[o].evidence).slice(0, 3).map((o) => (
                    <p key={o} className="mt-2 text-xs text-fg-2"><strong className="text-fg">{ORGAN_NAMES[o]} (label): </strong>“{kbDrug.organs[o].evidence}”</p>
                  ))}
                </Card>
              </div>
              {approvedDossier ? <DossierView d={approvedDossier} pred={labelAsPrediction(kbDrug)} kb={kb} /> : (
                <Callout tone="info" title="No pharmacokinetic model for this medicine">The liability layer is available for all {kb.drugs.length} medicines; exposure-stratified dossiers require a PK model ({Object.keys(DRUG_MAP).filter((k) => !k.startsWith('cand:')).length} medicines). Use “New molecule” to enter PK parameters.</Callout>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
          <div className="flex flex-col gap-4 print:hidden">
            <Card title="Molecule">
              <div className="flex flex-col gap-3">
                <Field label="Start from example" htmlFor="ex">
                  <Select id="ex" value={ex.id} onChange={(e) => {
                    const n = EXAMPLES.find((x) => x.id === e.target.value)!;
                    setEx(n);
                    setSmiles(n.smiles);
                    setClasses(n.classes);
                    setPk(n.pk);
                    setName(`MC-${n.id === 'quinolone' ? '101' : n.id === 'statin' ? '202' : '303'} (${n.label.toLowerCase()})`);
                    setResult(null);
                  }}>
                    {EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </Select>
                </Field>
                <Field label="Name" htmlFor="nm"><Input id="nm" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label="Structure (SMILES)" htmlFor="smi" error={mol && !mol.valid ? mol.error ?? 'Not a valid structure' : undefined}>
                  <textarea id="smi" value={smiles} maxLength={500} onChange={(e) => setSmiles(e.target.value)} className="min-h-20 w-full rounded-lg border border-line-strong bg-surface p-2 font-mono text-xs" spellCheck={false} />
                </Field>
                {mol?.valid && mol.svg && (
                  <div className="rounded-xl bg-white p-2">
                    <img alt="2D structure" className="mx-auto" src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(mol.svg)))}`} />
                    <p className="text-center text-[11px] text-[#334]">MW {fmt(mol.mw)} · cLogP {fmt(mol.logp)} · TPSA {fmt(mol.tpsa)} · HBD {mol.hbd} · HBA {mol.hba}</p>
                  </div>
                )}
                {!mol && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />Loading RDKit structure engine…</p>}
                <Field label="Pharmacologic class (FDA EPC/MoA)" htmlFor="cls" hint="Optional — improves analogue matching">
                  <Select id="cls" value="" onChange={(e) => e.target.value && setClasses(Array.from(new Set([...classes, e.target.value])))}>
                    <option value="">Add class…</option>
                    {allClasses.map((c) => <option key={c}>{c}</option>)}
                  </Select>
                </Field>
                <div className="flex flex-wrap gap-1.5">{classes.map((c) => <Badge key={c}>{c}<button aria-label={`Remove ${c}`} className="ml-0.5 hover:text-danger" onClick={() => setClasses(classes.filter((x) => x !== c))}>×</button></Badge>)}</div>
              </div>
            </Card>
            <Card title="Human pharmacokinetics" subtitle="From allometry / first-in-human data (see Drug discovery)">
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Clearance" value={pk.CL} min={0.01} max={1000} unit="L/h" onChange={(v) => setPk({ ...pk, CL: v })} />
                <NumberField label="Volume (Vss)" value={pk.V} min={1} max={50000} unit="L" onChange={(v) => setPk({ ...pk, V: v })} />
                <NumberField label="Oral F" value={pk.F} min={0.01} max={1} step={0.05} onChange={(v) => setPk({ ...pk, F: v })} />
                <NumberField label="ka" value={pk.ka} min={0.05} max={10} unit="1/h" onChange={(v) => setPk({ ...pk, ka: v })} />
                <NumberField label="Renal fraction" value={pk.fe} min={0} max={1} step={0.05} onChange={(v) => setPk({ ...pk, fe: v })} />
                <NumberField label="Fraction unbound" value={pk.fu} min={0.001} max={1} step={0.01} onChange={(v) => setPk({ ...pk, fu: v })} />
                <NumberField label="Dose" value={pk.dose} min={0.1} max={5000} unit="mg" onChange={(v) => setPk({ ...pk, dose: v })} />
                <NumberField label="Interval" value={pk.intervalH} min={1} max={168} unit="h" onChange={(v) => setPk({ ...pk, intervalH: v })} />
                <NumberField label="Target low" value={pk.targetLow} min={0.0001} max={1000} unit="mg/L" onChange={(v) => setPk({ ...pk, targetLow: v })} />
                <NumberField label="Target high" value={pk.targetHigh} min={0.0001} max={1000} unit="mg/L" onChange={(v) => setPk({ ...pk, targetHigh: v })} />
                <div className="col-span-2"><NumberField label="Toxicity threshold (NOAEL exposure / margin)" value={pk.toxicConc} min={0.0001} max={10000} unit="mg/L" onChange={(v) => setPk({ ...pk, toxicConc: v })} /></div>
              </div>
              <p className="mb-2 mt-4 text-xs font-medium text-fg-2">Metabolic pathways (fraction of non-renal clearance)</p>
              {pk.metabolism.map((m, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_100px_auto] items-end gap-2">
                  <Select aria-label="Pathway" value={m.pathway} onChange={(e) => setPk({ ...pk, metabolism: pk.metabolism.map((x, j) => (j === i ? { ...x, pathway: e.target.value as Pathway } : x)) })}>{PATHWAYS.map((p) => <option key={p}>{p}</option>)}</Select>
                  <Input aria-label="Fraction metabolised" type="number" min={0} max={1} step={0.05} value={m.fm} onChange={(e) => setPk({ ...pk, metabolism: pk.metabolism.map((x, j) => (j === i ? { ...x, fm: Math.min(1, Math.max(0, Number(e.target.value))) } : x)) })} />
                  <button className="mb-2 text-muted hover:text-danger" aria-label="Remove pathway" onClick={() => setPk({ ...pk, metabolism: pk.metabolism.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <Button size="sm" variant="secondary" disabled={pk.metabolism.length >= 4} onClick={() => setPk({ ...pk, metabolism: [...pk.metabolism, { pathway: 'CYP3A4', fm: 0.2 }] })}>Add pathway</Button>
            </Card>
            <Button icon={<FlaskConical className="size-4" />} onClick={runNew} loading={busy} disabled={!mol?.valid}>Run regulatory twin</Button>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {!result ? (
              <Callout tone="info" title="Prospective safety review">Enter a structure and human PK. The twin finds structural and pharmacological analogues among {kb.drugs.length} FDA-labelled drugs, infers organ liabilities with an applicability-domain check, simulates exposure across special populations and interactions, and drafts the label sections and reviewer questions.</Callout>
            ) : (
              <>
                <Card title={`Predicted organ liabilities — ${name}`} subtitle={result.pred.applicability.note}>
                  <LiabilityBars pred={result.pred} />
                  {result.pred.neighbours.length > 0 && (
                    <p className="mt-3 text-xs text-muted">Nearest analogues: {result.pred.neighbours.slice(0, 5).map((n) => `${n.drug.genericName} (${n.similarity.toFixed(2)})`).join(', ')}</p>
                  )}
                </Card>
                <DossierView d={result.dossier} pred={result.pred} kb={kb} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

