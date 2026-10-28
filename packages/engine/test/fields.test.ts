import { describe, expect, it } from 'vitest';
import {
  BUG_DRUGS, CHEMICALS, CHEMO, ENVIRONMENTS, METABOLIC_DRUGS, SPECIES, ageSignals, childPatient, defaultPatient, deprescribe, derivePhysiology,
  detectionWindow, environmentComparison, glucoseDay, impliedDose, makeRegimen, occupancyForecast, oncologyTrial, ontogenyFactors,
  organSupportScenarios, paediatricDoseCurve, resistanceEmergence, reverseDosimetry, sessionRemoval, speciesTwin, targetAttainment,
} from '../src/index.js';

describe('paediatrics', () => {
  it('enzyme ontogeny matures toward adult activity', () => {
    expect(ontogenyFactors(0.05).CYP3A4).toBeLessThan(0.3);
    expect(ontogenyFactors(10).CYP3A4).toBeGreaterThan(0.9);
    expect(derivePhysiology(childPatient(0.1)).enzymeActivity.UGT).toBeLessThan(0.3);
  });
  it('twin dose differs from linear mg/kg scaling in neonates and toddlers', () => {
    const c = paediatricDoseCurve('midazolam', [0.1, 2]);
    expect(c[0].mgPerKgTwin).toBeLessThan(c[0].mgPerKgLinear); // immature CYP3A4
    expect(c[1].mgPerKgTwin).toBeGreaterThan(c[1].mgPerKgLinear); // higher weight-normalised clearance
  }, 30000);
});

describe('antimicrobial resistance', () => {
  it('target attainment falls as MIC rises', () => {
    const r = targetAttainment(BUG_DRUGS[0], makeRegimen('vancomycin', { doses: 6 }), 40);
    expect(r.byMic[0].pta).toBeGreaterThan(r.byMic[r.byMic.length - 1].pta);
    expect(r.cfr).toBeGreaterThan(0);
    expect(r.cfr).toBeLessThanOrEqual(1);
  }, 30000);
  it('clears a susceptible strain but selects resistance at a borderline MIC', () => {
    const reg = makeRegimen('ciprofloxacin', { doses: 14 });
    const sus = resistanceEmergence(defaultPatient(), reg, 0.015);
    const border = resistanceEmergence(defaultPatient(), reg, 0.25);
    expect(sus.cleared).toBe(true);
    expect(border.mswFraction).toBeGreaterThan(0.5);
    expect(border.pResistanceEmergence).toBeGreaterThan(sus.pResistanceEmergence);
  });
});

describe('oncology', () => {
  it('reproduces the docetaxel neutropenia time course', () => {
    const r = oncologyTrial(CHEMO[0], CHEMO[0].standard, 60);
    expect(r.pGrade3plus).toBeGreaterThan(0.5);
    expect(r.medianNadirDay).toBeGreaterThan(5);
    expect(r.medianNadirDay).toBeLessThan(11);
    const lower = oncologyTrial(CHEMO[0], { ...CHEMO[0].standard, dose: 50 }, 60);
    expect(lower.pGrade3plus).toBeLessThan(r.pGrade3plus);
  }, 60000);
});

describe('geriatrics', () => {
  it('computes age signals and deprescribes the highest-burden drugs', () => {
    const sig = ageSignals({ a: { '0-1': 0, '2-11': 0, '12-17': 0, '18-44': 10, '45-64': 20, '65-74': 40, '75+': 60 }, b: { '0-1': 30, '2-11': 40, '12-17': 20, '18-44': 50, '45-64': 20, '65-74': 5, '75+': 5 } });
    expect(sig.find((s) => s.name === 'a')!.elderlyRatio).toBeGreaterThan(1);
    expect(sig.find((s) => s.name === 'b')!.paediatricRatio).toBeGreaterThan(1);
    const p = defaultPatient({ age: 84, scr: 1.4 });
    const r = deprescribe(p, ['midazolam', 'morphine', 'haloperidol', 'amlodipine', 'atorvastatin'], ['atorvastatin']);
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.finalBurden.total).toBeLessThan(r.baseline.total);
    expect(r.final).toContain('atorvastatin');
  });
});

describe('organ support & ICU', () => {
  it('dialysis and sepsis shift exposure in the expected directions', () => {
    const r = organSupportScenarios('vancomycin');
    const [normal, anuric, ihd, crrt, sepsis] = r.scenarios;
    expect(anuric.auc24).toBeGreaterThan(normal.auc24 * 2);
    expect(crrt.auc24).toBeLessThan(anuric.auc24);
    expect(ihd.auc24).toBeLessThan(anuric.auc24);
    expect(sepsis.auc24).toBeLessThan(normal.auc24);
    expect(sessionRemoval('gentamicin')).toBeGreaterThan(sessionRemoval('amiodarone'));
  });
});

describe('mental health', () => {
  it('higher haloperidol doses overshoot the D2 window', () => {
    const low = occupancyForecast(defaultPatient(), makeRegimen('haloperidol', { dose: 1, doses: 28 }));
    const high = occupancyForecast(defaultPatient(), makeRegimen('haloperidol', { dose: 10, doses: 28 }));
    expect(high.troughOccupancy).toBeGreaterThan(low.troughOccupancy);
    expect(high.timeAbove).toBeGreaterThan(low.timeAbove);
  });
});

describe('diabetes', () => {
  it('metformin lowers and prednisone raises mean glucose in type 2 diabetes', () => {
    const base = glucoseDay({ type: 't2d', weightKg: 85 }, []);
    const met = glucoseDay({ type: 't2d', weightKg: 85 }, [METABOLIC_DRUGS[0]]);
    const pred = glucoseDay({ type: 't2d', weightKg: 85 }, [METABOLIC_DRUGS[2]]);
    expect(met.meanGlucose).toBeLessThan(base.meanGlucose);
    expect(pred.meanGlucose).toBeGreaterThan(base.meanGlucose);
    expect(glucoseDay({ type: 'healthy', weightKg: 70 }, []).hba1c).toBeLessThan(base.hba1c);
  });
});

describe('veterinary, environment, extreme, doping', () => {
  it('species scaling and withdrawal times', () => {
    const cattle = speciesTwin('gentamicin', SPECIES.find((s) => s.id === 'cattle')!);
    expect(cattle.withdrawalDays).toBeGreaterThan(0);
    expect(speciesTwin('gentamicin', SPECIES[0]).withdrawalDays).toBeNull();
  });
  it('reverse dosimetry scales with the biomonitoring level', () => {
    const a = reverseDosimetry(CHEMICALS[0], 1);
    const b = reverseDosimetry(CHEMICALS[0], 4);
    expect(b.intakeMedian / a.intakeMedian).toBeCloseTo(4, 1);
  });
  it('heat increases lithium exposure', () => {
    const r = environmentComparison('lithium');
    expect(r.find((x) => x.env.id === 'heat')!.aucRatio).toBeGreaterThan(1.2);
    expect(ENVIRONMENTS.length).toBeGreaterThan(3);
  });
  it('detection window and implied dose are consistent', () => {
    const w = detectionWindow('furosemide', 40, 1);
    expect(w.lastDetectableH).toBeGreaterThan(4);
    const at6 = w.conc[w.t.findIndex((t) => t >= 6)];
    expect(impliedDose('furosemide', at6, 6)).toBeCloseTo(40, -1);
  });
});
