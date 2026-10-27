import { describe, expect, it } from 'vitest';
import {
  analyzeHistory, bayesianEstimate, ckdEpi2021, cockcroftGault, DRUGS, defaultPatient, derivePhysiology, evaluateAlerts,
  firstInHuman, EXAMPLE_COMPOUND, makeRegimen, marsh, minto, nelderMead, predictBIS, recommendDose, runTrial, DEFAULT_POPULATION,
  schnider, simulate, tciStep, scoreCase, TRAINING_CASES, assessDruglikeness, ascendingDoseStudy, getDrug, isDrugId,
} from '../src/index.js';

const ref = defaultPatient();
const auc = (drugId: string, others: string[] = [], patient = ref, days = 14) => {
  const mk = (id: string) => makeRegimen(id, { doses: Math.round((24 * days) / DRUGS.find((d) => d.id === id)!.defaultRegimen.intervalH) });
  return simulate({ patient, regimens: [mk(drugId), ...others.map(mk)], metricsOnly: true }).metrics[drugId].auc24;
};

describe('physiology', () => {
  it('Cockcroft–Gault matches hand calculation', () => {
    expect(cockcroftGault(60, 72, 1.0, 'male')).toBeCloseTo(80, 0);
    expect(cockcroftGault(60, 72, 1.0, 'female')).toBeCloseTo(68, 0);
  });
  it('CKD-EPI 2021 reference values', () => {
    // 50-year-old male, SCr 1.0 → ~92 mL/min/1.73m² (published calculator)
    expect(ckdEpi2021(1.0, 50, 'male')).toBeGreaterThan(88);
    expect(ckdEpi2021(1.0, 50, 'male')).toBeLessThan(95);
  });
  it('procedures change physiology and recover over time', () => {
    const p = defaultPatient({ procedures: [{ id: 'x', type: 'hepatectomy', date: '2026-01-01' }] });
    const early = derivePhysiology(p, new Date('2026-01-02'));
    const late = derivePhysiology(p, new Date('2026-06-01'));
    expect(early.hepaticFactor).toBeLessThan(late.hepaticFactor);
    const bypass = derivePhysiology(defaultPatient({ procedures: [{ id: 'y', type: 'rygb', date: '2020-01-01' }] }));
    expect(bypass.absorptionFactor).toBeCloseTo(0.7, 2);
  });
});

describe('pharmacokinetics', () => {
  it('every drug simulates with finite, non-negative output', () => {
    for (const d of DRUGS) {
      const r = simulate({ patient: ref, regimens: [makeRegimen(d.id)] });
      const s = r.series[d.id].conc;
      expect(s.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(r.metrics[d.id].cmax).toBeGreaterThan(0);
    }
  });
  it('IV bolus one-compartment matches analytic solution', () => {
    const r = simulate({ patient: ref, regimens: [makeRegimen('gentamicin', { route: 'iv_bolus', dose: 400, unit: 'mg', doses: 1 })], durationH: 8 });
    const p = r.params.gentamicin;
    const k = p.CL / p.Vc;
    const idx = r.t.findIndex((t) => t >= 4);
    const analytic = (400 / p.Vc) * Math.exp(-k * r.t[idx]);
    expect(r.series.gentamicin.conc[idx]).toBeCloseTo(analytic, 2);
  });
  it('vancomycin standard regimen gives AUC24 in 400–600 for reference adult', () => {
    const m = simulate({ patient: ref, regimens: [makeRegimen('vancomycin', { doses: 8 })], metricsOnly: true }).metrics.vancomycin;
    expect(m.auc24).toBeGreaterThan(380);
    expect(m.auc24).toBeLessThan(600);
  });
  it('renal impairment increases exposure of renally cleared drugs', () => {
    const ckd = defaultPatient({ scr: 3 });
    expect(auc('vancomycin', [], ckd, 4) / auc('vancomycin', [], ref, 4)).toBeGreaterThan(2);
  });
  it('phenytoin shows more-than-proportional increase (Michaelis–Menten)', () => {
    const m = (dose: number) =>
      simulate({ patient: ref, regimens: [makeRegimen('phenytoin', { dose, doses: 90 })], metricsOnly: true }).metrics.phenytoin.avgLast;
    expect(m(133) / m(100)).toBeGreaterThan(1.6);
  });
});

describe('drug–drug interactions', () => {
  it('strong CYP3A4 inhibitor raises atorvastatin exposure 3–7×', () => {
    const r = auc('atorvastatin', ['clarithromycin']) / auc('atorvastatin');
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThan(7);
  });
  it('rifampicin induction lowers midazolam exposure', () => {
    expect(auc('midazolam', ['rifampin']) / auc('midazolam')).toBeLessThan(0.5);
  });
  it('ciprofloxacin roughly doubles theophylline', () => {
    const r = auc('theophylline', ['ciprofloxacin']) / auc('theophylline');
    expect(r).toBeGreaterThan(1.5);
    expect(r).toBeLessThan(3);
  });
  it('NSAID raises lithium exposure via renal interaction', () => {
    expect(auc('lithium', ['ibuprofen']) / auc('lithium')).toBeGreaterThan(1.15);
  });
  it('CYP2D6 UM increases codeine active exposure; CYP2C19 PM reduces clopidogrel activation', () => {
    const um = defaultPatient({ phenotypes: { CYP2D6: 'UM', CYP2C19: 'PM', CYP2C9: 'NM', CYP3A5: 'PM' } });
    expect(auc('codeine', [], um) / auc('codeine')).toBeGreaterThan(1.8);
    expect(auc('clopidogrel', [], um) / auc('clopidogrel')).toBeLessThan(0.8);
  });
  it('alerts flag curated pairs, PGx and QT stacking', () => {
    const p = defaultPatient({ phenotypes: { CYP2D6: 'UM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'PM' } });
    const alerts = evaluateAlerts(p, derivePhysiology(p), ['warfarin', 'amiodarone', 'codeine', 'methadone', 'clarithromycin']);
    const titles = alerts.map((a) => a.title);
    expect(titles).toContain('Warfarin potentiation');
    expect(titles).toContain('Additive QT prolongation');
    expect(alerts.some((a) => a.category === 'pgx' && a.severity === 'contraindicated')).toBe(true);
    expect(alerts[0].severity).toBe('contraindicated');
  });
});

describe('dosing & Bayesian estimation', () => {
  it('Nelder–Mead finds the Rosenbrock minimum', () => {
    const r = nelderMead(([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2, [-1, 1], { maxIter: 2000, tol: 1e-12 });
    expect(r.x[0]).toBeCloseTo(1, 2);
    expect(r.x[1]).toBeCloseTo(1, 2);
  });
  it('dose recommendation brings exposure into range', () => {
    const regs = [makeRegimen('vancomycin', { dose: 500, doses: 8 })];
    const rec = recommendDose(ref, regs, 'vancomycin')!;
    expect(rec.recommendedDose).toBeGreaterThan(500);
    expect(rec.predictedValue).toBeGreaterThan(380);
    expect(rec.predictedValue).toBeLessThan(650);
  });
  it('MAP Bayesian estimate recovers a reduced clearance from levels', () => {
    const regs = [makeRegimen('vancomycin', { doses: 4 })];
    const truth = simulate({ patient: ref, regimens: regs, etas: { vancomycin: { CL: Math.log(0.5), V: 0, ka: 0 } } });
    const at = (t: number) => truth.series.vancomycin.conc[truth.t.findIndex((x) => x >= t)];
    const obs = [{ timeH: 38, value: at(38) }, { timeH: 47.9, value: at(47.9) }];
    const fit = bayesianEstimate(ref, regs, 'vancomycin', obs);
    const ratio = fit.individual.CL / fit.population.CL;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.65);
  });
});

describe('population trial', () => {
  it('is reproducible from the seed and returns percentile bands', () => {
    const arms = [{ id: 'a', label: 'Standard', regimens: [makeRegimen('vancomycin', { doses: 6 })] }];
    const r1 = runTrial({ ...DEFAULT_POPULATION, n: 30 }, arms, 'vancomycin');
    const r2 = runTrial({ ...DEFAULT_POPULATION, n: 30 }, arms, 'vancomycin');
    expect(r1[0].summary.auc24Median).toBeCloseTo(r2[0].summary.auc24Median, 6);
    const i = 60;
    expect(r1[0].percentiles.p5[i]).toBeLessThanOrEqual(r1[0].percentiles.p50[i]);
    expect(r1[0].percentiles.p50[i]).toBeLessThanOrEqual(r1[0].percentiles.p95[i]);
    expect(r1[0].pta).not.toBeNull();
  });
});

describe('anaesthesia', () => {
  const pt = { age: 45, weightKg: 70, heightCm: 170, sex: 'male' as const };
  it('models produce sensible parameters', () => {
    expect(marsh(pt).V1).toBeCloseTo(15.96, 2);
    expect(schnider(pt).V1).toBe(4.27);
    expect(minto(pt).ke0).toBeGreaterThan(0.5);
  });
  it('effect-site TCI reaches target without overshoot', () => {
    const k = schnider(pt);
    let s = { a1: 0, a2: 0, a3: 0, ce: 0 };
    let maxCe = 0;
    for (let i = 0; i < 60; i++) {
      const r = tciStep(s, k, 3, 'effect', 1200 * 10 / 60, 1 / 6);
      s = r.state;
      maxCe = Math.max(maxCe, r.ce);
    }
    expect(s.ce).toBeGreaterThan(2.8);
    expect(maxCe).toBeLessThan(3.1);
  });
  it('BIS decreases with propofol and remifentanil', () => {
    expect(predictBIS(0, 0)).toBeCloseTo(97.4, 1);
    expect(predictBIS(4, 0)).toBeLessThan(55);
    expect(predictBIS(3, 4)).toBeLessThan(predictBIS(3, 0));
  });
});

describe('drug discovery', () => {
  it('computes FDA HED and MRSD', () => {
    const r = firstInHuman({ ...EXAMPLE_COMPOUND, species: 'rat', noaelMgKg: 50, safetyFactor: 10 });
    expect(r.hedMgKg).toBeCloseTo(8.11, 2);
    expect(r.mrsdMgKg).toBeCloseTo(0.811, 3);
  });
  it('drug-likeness flags Lipinski violations', () => {
    const r = assessDruglikeness({ ...EXAMPLE_COMPOUND, mw: 650, logP: 6.2 });
    expect(r.lipinskiViolations.length).toBe(2);
  });
  it('MAD accumulation exceeds SAD', () => {
    const fih = firstInHuman(EXAMPLE_COMPOUND);
    const sad = ascendingDoseStudy(EXAMPLE_COMPOUND, fih, [100], false)[0];
    const mad = ascendingDoseStudy(EXAMPLE_COMPOUND, fih, [100], true)[0];
    expect(mad.cmax).toBeGreaterThan(sad.cmax);
  });
});

describe('lookups', () => {
  it('does not resolve prototype keys as drugs', () => {
    expect(() => getDrug('constructor')).toThrow();
    expect(() => getDrug('__proto__')).toThrow();
    expect(isDrugId('warfarin')).toBe(true);
    expect(isDrugId('toString')).toBe(false);
  });
});

describe('history & training', () => {
  it('detects residual amiodarone, carry-over inhibition and cumulative doxorubicin', () => {
    const p = defaultPatient({
      medicationHistory: [
        { id: 'a', drugId: 'amiodarone', dose: 400, unit: 'mg', intervalH: 24, route: 'po', start: '2026-05-01T08:00:00Z', end: '2026-09-01T08:00:00Z' },
        { id: 'b', drugId: 'doxorubicin', dose: 60, unit: 'mg/m2', intervalH: 504, route: 'iv_infusion', infusionH: 0.25, start: '2025-01-01T08:00:00Z', end: '2025-06-01T08:00:00Z' },
      ],
    });
    const h = analyzeHistory(p, new Date('2026-10-01T08:00:00Z'));
    expect(h.residual.find((r) => r.drugId === 'amiodarone')!.value).toBeGreaterThan(0.2);
    const dox = h.cumulative.find((c) => c.drugId === 'doxorubicin')!;
    expect(dox.limit!.pct).toBeGreaterThan(90);
    expect(h.lasting.some((l) => l.kind === 'cumulative')).toBe(true);
    expect(h.carryOver).not.toBeNull();
  });
  it('scores training cases', () => {
    const c = TRAINING_CASES[0];
    const answers = Object.fromEntries(c.questions.map((q) => [q.id, q.answer]));
    expect(scoreCase(c.id, answers).score).toBe(c.questions.length);
  });
});
