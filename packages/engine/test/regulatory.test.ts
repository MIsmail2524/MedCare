import { describe, expect, it } from 'vitest';
import {
  assessCausality, auroc, buildDossier, candidateToDrug, childPugh, defaultPatient, diplotypeToPhenotype, faersOrganPRR, getDrug, labelSectionOrgans,
  leaveOneOut, organsInText, parseFhir, parseReportText, predictLiabilities, signalGaps, SAFETY_ORGANS, tanimoto, applyExtraction,
  type KBDrug, type SafetyKB,
} from '../src/index.js';

const organs = (pos: Partial<Record<string, 0 | 1 | 2>>, prr: Partial<Record<string, number>> = {}) =>
  Object.fromEntries(SAFETY_ORGANS.map((o) => [o, { label: pos[o] ?? 0, prr: prr[o] ?? 1, count: prr[o] ? 100 : 5, evidence: null, terms: [] }])) as KBDrug['organs'];
const fp = (bits: number[]) => {
  const b = new Uint8Array(256);
  for (const i of bits) b[i >> 3] |= 1 << (i & 7);
  return Buffer.from(b).toString('base64');
};
const drug = (name: string, bits: number[], classes: string[], pos: Partial<Record<string, 0 | 1 | 2>>, prr = {}): KBDrug => ({
  name, genericName: name, brands: [], classes, smiles: null, fp: fp(bits), chem: { mw: 300, xlogp: 2, tpsa: 60, hbd: 1, hba: 4, rotb: 3 }, faersTotal: 1000, boxed: false, organs: organs(pos, prr), labelSetId: null, labelDate: null,
});
const kb: SafetyKB = {
  version: 1, builtAt: '', faersTotal: 0, faersUpdated: null, validation: null,
  baseRates: Object.fromEntries(SAFETY_ORGANS.map((o) => [o, 0.2])) as SafetyKB['baseRates'],
  drugs: [
    drug('statin-a', [1, 2, 3, 4, 5, 6], ['HMG-CoA Reductase Inhibitor'], { muscle: 1, liver: 1 }),
    drug('statin-b', [1, 2, 3, 4, 5, 7], ['HMG-CoA Reductase Inhibitor'], { muscle: 1, liver: 1 }),
    drug('statin-c', [1, 2, 3, 4, 8, 9], ['HMG-CoA Reductase Inhibitor'], { muscle: 1 }),
    drug('quinolone-a', [100, 101, 102, 103], ['Fluoroquinolone Antibacterial'], { muscle: 2, heart: 1, brain: 1 }),
    drug('quinolone-b', [100, 101, 102, 104], ['Fluoroquinolone Antibacterial'], { muscle: 2, heart: 1 }, { liver: 4 }),
    drug('ssri-a', [200, 201, 202], ['Serotonin Reuptake Inhibitor'], { brain: 2 }),
    drug('ssri-b', [200, 201, 203], ['Serotonin Reuptake Inhibitor'], { brain: 1 }),
    drug('ppi-a', [300, 301, 302], ['Proton Pump Inhibitor'], { kidneys: 1 }),
    drug('ppi-b', [300, 301, 303], ['Proton Pump Inhibitor'], {}),
    drug('arb-a', [400, 401, 402], ['Angiotensin 2 Receptor Blocker'], { kidneys: 1 }),
    drug('arb-b', [400, 401, 403], ['Angiotensin 2 Receptor Blocker'], {}),
  ],
};

describe('safety knowledge base', () => {
  it('maps label and FAERS text to organ systems', () => {
    expect(organsInText('Risk of QT prolongation and hepatotoxicity')).toEqual(expect.arrayContaining(['heart', 'liver']));
    expect(labelSectionOrgans('5 WARNINGS 5.1 Hepatotoxicity Drug X may cause... the heart is fine. 5.2 Tendon Rupture Tendinitis has been...')).toEqual(expect.arrayContaining(['liver', 'muscle']));
    const prr = faersOrganPRR([['RHABDOMYOLYSIS', 50], ['NAUSEA', 50]], [['RHABDOMYOLYSIS', 60], ['NAUSEA', 5000], ['FATIGUE', 5000]]);
    expect(prr.muscle.prr).toBeGreaterThan(5);
  });
  it('computes Tanimoto and AUROC correctly', () => {
    const a = new Uint8Array([0b1111]);
    const b = new Uint8Array([0b0011]);
    expect(tanimoto(a, b)).toBeCloseTo(0.5);
    expect(auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auroc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
  });
  it('predicts class liabilities from structural/pharmacological neighbours with an applicability domain', () => {
    const q = { fp: Buffer.from(fp([1, 2, 3, 4, 5, 10]), 'base64'), classes: ['HMG-CoA Reductase Inhibitor'] };
    const r = predictLiabilities(q, kb);
    expect(r.liabilities[0].organ).toBe('muscle');
    expect(r.liabilities[0].probability).toBeGreaterThan(0.7);
    expect(r.applicability.inDomain).toBe(true);
    const novel = predictLiabilities({ fp: Buffer.from(fp([900, 901]), 'base64'), classes: ['Novel Mechanism'] }, kb);
    expect(novel.applicability.inDomain).toBe(false);
  });
  it('leave-one-out validation and signal-gap detection', () => {
    const v = leaveOneOut(kb.drugs, (d) => Buffer.from(d.fp!, 'base64'));
    expect(v.n).toBe(11);
    expect(v.organs.find((o) => o.organ === 'muscle')!.auroc).toBeGreaterThan(0.6);
    const gaps = signalGaps(kb, 2, 25);
    expect(gaps.some((g) => g.drug === 'quinolone-b' && g.organ === 'liver')).toBe(true);
  });
});

describe('regulatory twin dossier', () => {
  it('stratifies exposure and drafts label language for an approved drug', () => {
    const d = buildDossier(getDrug('vancomycin'), null, { trialN: 40, days: 4 });
    const renal = d.exposure.find((e) => e.id === 'renal')!;
    expect(renal.aucRatio).toBeGreaterThan(2);
    expect(d.label.dosing.some((x) => x.startsWith('Severe renal impairment'))).toBe(true);
    expect(d.benefitRisk.pta).not.toBeNull();
  });
  it('builds a candidate drug, flags CYP3A4 DDI and evidence gaps', () => {
    const liab = predictLiabilities({ fp: Buffer.from(fp([100, 101, 102, 105]), 'base64'), classes: ['Fluoroquinolone Antibacterial'] }, kb);
    const drugC = candidateToDrug({ name: 'MC-77 test', classes: ['Fluoroquinolone Antibacterial'], CL: 10, V: 150, F: 0.6, ka: 1, fe: 0.1, fu: 0.3, metabolism: [{ pathway: 'CYP3A4', fm: 0.8 }], dose: 200, intervalH: 24, route: 'po', targetLow: 0.3, targetHigh: 1.5 }, liab);
    const d = buildDossier(drugC, liab, { trialN: 30, days: 7 });
    const inh = d.exposure.find((e) => e.id === 'cyp3a_inh')!;
    expect(inh.aucRatio).toBeGreaterThan(2.5);
    expect(d.label.interactions.length).toBeGreaterThan(0);
    expect(d.reviewerQuestions.some((q) => /ICH M12/.test(q))).toBe(true);
    expect(d.label.warnings.some((w) => w.organ === 'muscle')).toBe(true);
  });
});

describe('ADR causality', () => {
  it('ranks the drug with labelled liability, plausible latency and high exposure first', () => {
    const p = defaultPatient({ scr: 2.6, age: 75 });
    const res = assessCausality(
      p,
      { organ: 'kidneys', onset: '2026-03-08T08:00:00Z', severity: 'severe' },
      [
        { name: 'vancomycin', drugId: 'vancomycin', start: '2026-03-01T08:00:00Z', dose: 1500, intervalH: 12 },
        { name: 'omeprazole', drugId: 'omeprazole', start: '2025-01-01T08:00:00Z', dose: 20, intervalH: 24 },
        { name: 'amlodipine', drugId: 'amlodipine', start: '2026-03-09T08:00:00Z', dose: 5, intervalH: 24 },
      ],
      null,
    );
    expect(res.candidates[0].name).toBe('vancomycin');
    expect(res.candidates.find((c) => c.name === 'amlodipine')!.factors.temporal).toBeLessThan(0.1);
    expect(res.management.some((m) => /creatinine/i.test(m))).toBe(true);
    expect(res.dechallenge?.drugId).toBe('vancomycin');
    expect(res.dechallenge!.stopped.at(-1)!).toBeLessThan(res.dechallenge!.continued.at(-1)!);
  });
});

describe('report import', () => {
  it('extracts labs, units, genotypes, Child–Pugh and medications from free text', () => {
    const ex = parseReportText(`Female, age 67. Weight 154 lb. Creatinine 141 umol/L. Albumin 28 g/L. Bilirubin 3.4 mg/dL, INR 1.9. Potassium 3.3 mmol/L.
Pharmacogenomics: CYP2D6 *4/*4. CYP2C19 *1/*17. HLA-B*15:02 positive.
Medications: warfarin 3 mg daily, metoprolol 50 mg bid.`);
    expect(ex.patch.sex).toBe('female');
    expect(ex.patch.scr).toBeCloseTo(1.6, 1);
    expect(ex.patch.albumin).toBeCloseTo(2.8, 1);
    expect(ex.patch.weightKg).toBeCloseTo(69.9, 0);
    expect(ex.patch.phenotypes?.CYP2D6).toBe('PM');
    expect(ex.patch.phenotypes?.CYP2C19).toBe('RM');
    expect(ex.patch.hla?.B1502).toBe(true);
    expect(ex.patch.childPugh).toBe('B');
    expect(ex.medications.map((m) => m.drugId)).toEqual(expect.arrayContaining(['warfarin', 'metoprolol']));
    expect(ex.medications.find((m) => m.drugId === 'metoprolol')!.intervalH).toBe(12);
    const merged = applyExtraction(defaultPatient(), ex);
    expect(merged.phenotypes.CYP2D6).toBe('PM');
    expect(merged.phenotypes.CYP2C9).toBe('NM');
  });
  it('parses FHIR bundles with LOINC observations', () => {
    const ex = parseFhir({
      resourceType: 'Bundle',
      entry: [
        { resource: { resourceType: 'Patient', gender: 'male', birthDate: '1960-01-01' } },
        { resource: { resourceType: 'Observation', code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] }, valueQuantity: { value: 1.4, unit: 'mg/dL' } } },
        { resource: { resourceType: 'MedicationStatement', medicationCodeableConcept: { text: 'Lithium carbonate 450 mg' }, dosage: [{ text: 'twice daily' }] } },
      ],
    }, new Date('2026-01-01'));
    expect(ex.patch.scr).toBe(1.4);
    expect(ex.patch.age).toBe(66);
    expect(ex.medications[0].drugId).toBe('lithium');
  });
  it('phenotype and Child–Pugh helpers', () => {
    expect(diplotypeToPhenotype('CYP2D6', '1', '1xN')).toBe('UM');
    expect(diplotypeToPhenotype('CYP3A5', '1', '3')).toBe('IM');
    expect(childPugh(1.0, 4.0, 1.0)?.cls).toBe('none');
    expect(childPugh(3.5, 2.5, 2.5)?.cls).toBe('C');
  });
});
