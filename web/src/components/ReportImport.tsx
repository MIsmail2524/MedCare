import { useState } from 'react';
import { FileUp } from 'lucide-react';
import { applyExtraction, parseFhir, parseReportCsv, parseReportText, type Patient, type ReportExtraction } from '@medcare/engine';
import { Badge, Button, Callout, Modal } from './ui';

const SAMPLE = `Discharge summary — female, age 67. Weight 154 lb, height 162 cm.
Labs: Creatinine 141 umol/L, Albumin 28 g/L, Total bilirubin 2.4 mg/dL, INR 1.6, Potassium 3.3 mmol/L, ALT 64 U/L.
ECG: QTc 468 ms. Heart rate 88 bpm. History of heart failure (HFrEF).
Pharmacogenomic panel: CYP2D6 *4/*4; CYP2C19 *1/*17; CYP2C9 *1/*3. HLA-B*15:02 negative.
Medications: warfarin 3 mg daily, metoprolol 50 mg bid, furosemide 40 mg daily, amiodarone 200 mg daily.`;

/** Import labs, genotypes and medications from reports. Parsing runs entirely in the browser. */
export function ReportImport({ patient, onApply }: { patient: Patient; onApply: (p: Patient) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [ex, setEx] = useState<ReportExtraction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const parse = (src: string, filename = 'pasted text') => {
    setErr(null);
    try {
      const t = src.trim();
      if (filename.endsWith('.json') || t.startsWith('{')) setEx(parseFhir(JSON.parse(t)));
      else if (filename.endsWith('.csv')) setEx(parseReportCsv(t, filename));
      else setEx(parseReportText(t, filename));
    } catch {
      setErr('Could not parse this file. Supported: plain text, CSV, FHIR R4 JSON.');
    }
  };
  return (
    <>
      <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setOpen(true)}>Import reports</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import medical reports into the twin"
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!ex || (!ex.findings.length && !ex.medications.length)} onClick={() => { onApply(applyExtraction(patient, ex!)); setOpen(false); setEx(null); setText(''); }}>Apply to twin</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Callout tone="info">Paste a lab report, discharge letter or genotype report, or upload a .txt, .csv or FHIR R4 .json file. Parsing happens locally in your browser; nothing is uploaded until you save the twin. Use de-identified documents only.</Callout>
          <textarea aria-label="Report text" value={text} onChange={(e) => setText(e.target.value)} maxLength={200000} placeholder="Paste report text…" className="min-h-40 w-full rounded-lg border border-line-strong bg-surface p-3 font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => parse(text)} disabled={!text.trim()}>Extract</Button>
            <Button size="sm" variant="secondary" onClick={() => { setText(SAMPLE); parse(SAMPLE, 'sample'); }}>Try a sample report</Button>
            <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-line-strong px-3 text-xs font-medium hover:bg-surface-2">
              Upload file
              <input type="file" accept=".txt,.csv,.json,text/plain,application/json" className="sr-only" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 5_000_000) { setErr('File too large (max 5 MB).'); return; }
                const t = await f.text();
                setText(t.slice(0, 200000));
                parse(t, f.name.toLowerCase());
              }} />
            </label>
          </div>
          {err && <Callout tone="danger">{err}</Callout>}
          {ex && (
            <div>
              <p className="mb-2 text-sm font-semibold">Extracted ({ex.findings.length} findings)</p>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Item</th><th className="pb-1 font-medium">Value</th><th className="pb-1 font-medium">Confidence</th></tr></thead>
                <tbody>
                  {ex.findings.map((f, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1">{f.label}</td>
                      <td className="tabular">{String(f.value)} {f.unit ?? ''}</td>
                      <td><Badge tone={f.confidence === 'high' ? 'ok' : f.confidence === 'medium' ? 'warn' : 'neutral'}>{f.confidence}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ex.warnings.map((w) => <p key={w} className="mt-2 text-xs text-warn">{w}</p>)}
              {!ex.findings.length && <p className="text-sm text-muted">Nothing recognised — check units and labels.</p>}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
