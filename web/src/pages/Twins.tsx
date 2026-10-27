import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Users, Copy } from 'lucide-react';
import { defaultPatient, derivePhysiology, type Patient } from '@medcare/engine';
import { post } from '../lib/api';
import { useTwins } from '../lib/twins';
import { useToast } from '../lib/toast';
import { relativeTime } from '../lib/format';
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Skeleton } from '../components/ui';
import { SearchInput } from '../components/clinical';

const TEMPLATES: { id: string; label: string; body: string; patient: () => Patient }[] = [
  { id: 'adult', label: 'Healthy adult', body: '40 y, 70 kg, normal organ function', patient: () => defaultPatient({ name: 'New patient' }) },
  { id: 'elderly', label: 'Frail elderly with CKD', body: '82 y, 55 kg, SCr 1.7, polypharmacy risk', patient: () => defaultPatient({ name: 'Elderly patient', age: 82, sex: 'female', weightKg: 55, heightCm: 158, scr: 1.7, albumin: 3.3, conditions: [{ id: 'c1', name: 'CKD stage 3b' }, { id: 'c2', name: 'Osteoarthritis' }] }) },
  { id: 'cirrhosis', label: 'Cirrhosis (Child–Pugh B)', body: '58 y, alcohol-related liver disease', patient: () => defaultPatient({ name: 'Cirrhotic patient', age: 58, weightKg: 74, albumin: 2.8, childPugh: 'B', alcoholUse: 'heavy' }) },
  { id: 'pregnant', label: 'Pregnancy (3rd trimester)', body: '31 y, 78 kg, physiological changes of pregnancy', patient: () => defaultPatient({ name: 'Pregnant patient', age: 31, sex: 'female', weightKg: 78, heightCm: 165, scr: 0.55, pregnant: true }) },
  { id: 'child', label: 'Child (8 years)', body: '8 y, 26 kg, bedside Schwartz renal function', patient: () => defaultPatient({ name: 'Paediatric patient', age: 8, weightKg: 26, heightCm: 128, scr: 0.45 }) },
  { id: 'obese', label: 'Class III obesity', body: '45 y, 145 kg, adjusted body weight dosing', patient: () => defaultPatient({ name: 'Obese patient', age: 45, weightKg: 145, heightCm: 172, scr: 1.0 }) },
];

export default function Twins() {
  const { twins, reload } = useTwins();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [tpl, setTpl] = useState('adult');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const create = async (patient: Patient, label: string) => {
    setBusy(true);
    try {
      const r = await post<{ twin: { id: string } }>('/twins', { name: label, data: { ...patient, name: label } });
      toast('Twin created');
      nav(`/app/twins/${r.twin.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const list = (twins ?? []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader
        icon={<Users className="size-5" />}
        title="Patient digital twins"
        description="Virtual patients that combine physiology, genetics, conditions and history. Use synthetic data only — never identifiable patient information."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => { setName(''); setOpen(true); }}>New twin</Button>}
      />
      <div className="mb-4 max-w-sm">
        <SearchInput value={q} onChange={setQ} placeholder="Search twins…" label="Search twins" />
      </div>
      {!twins ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title={q ? 'No matching twins' : 'Create your first twin'} body="Start from a clinical template — you can edit every parameter afterwards." action={<Button onClick={() => setOpen(true)} icon={<Plus className="size-4" />}>New twin</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => {
            const p = derivePhysiology(t.data);
            return (
              <div key={t.id} className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-[var(--shadow)]">
                <Link to={`/app/twins/${t.id}`} className="group">
                  <p className="font-semibold group-hover:text-primary">{t.name}</p>
                  <p className="text-xs text-muted">{t.data.age} y · {t.data.sex} · {t.data.weightKg} kg · BMI {p.bmi.toFixed(1)}</p>
                </Link>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge tone={p.crcl < 30 ? 'danger' : p.crcl < 60 ? 'warn' : 'ok'}>CrCl {Math.round(p.crcl)} mL/min</Badge>
                  {t.data.childPugh !== 'none' && <Badge tone="warn">Child–Pugh {t.data.childPugh}</Badge>}
                  {Object.entries(t.data.phenotypes).filter(([, v]) => v !== 'NM' && v !== 'PM').map(([k, v]) => <Badge key={k} tone="info">{k} {v}</Badge>)}
                  {Object.entries(t.data.phenotypes).filter(([k, v]) => v === 'PM' && k !== 'CYP3A5').map(([k]) => <Badge key={k} tone="info">{k} PM</Badge>)}
                  {t.data.pregnant && <Badge tone="primary">Pregnant</Badge>}
                </div>
                <div className="mt-auto flex items-center justify-between pt-4 text-xs text-muted">
                  <span>Updated {relativeTime(t.updatedAt)}</span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => create(t.data, `${t.name} (copy)`).then(reload)} aria-label={`Duplicate ${t.name}`}>Duplicate</Button>
                    <Link to={`/app/simulate?twin=${t.id}`} className="inline-flex h-8 items-center rounded-lg bg-primary-soft px-3 text-xs font-medium text-primary hover:bg-primary hover:text-primary-fg">Simulate</Link>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New digital twin"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={() => { const t = TEMPLATES.find((x) => x.id === tpl)!; create(t.patient(), name.trim() || t.label); }}>Create twin</Button></>}
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="tname" hint="Use a pseudonym — do not enter real patient identifiers.">
            <Input id="tname" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Case 12 — post-op AKI" />
          </Field>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-fg-2">Start from template</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <label key={t.id} className={`cursor-pointer rounded-xl border p-3 text-sm ${tpl === t.id ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong'}`}>
                  <input type="radio" name="tpl" value={t.id} checked={tpl === t.id} onChange={() => setTpl(t.id)} className="sr-only" />
                  <span className="block font-medium">{t.label}</span>
                  <span className="block text-xs text-muted">{t.body}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>
    </div>
  );
}
