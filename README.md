# MedCare Twin

**A physiology-based digital twin for simulating how medicines — and past medicines and operations — affect the human body.**

MedCare Twin lets doctors, surgeons, pharmacists, students and drug developers rehearse prescribing on a virtual patient: predict concentrations, effects and organ-level toxicity; screen interactions and pharmacogenomics; individualise doses from measured levels; run virtual clinical trials; practise target-controlled anaesthesia; and take a new compound from preclinical data to a first-in-human dose.

> ⚠️ **Intended use:** education, training and early-stage research only. MedCare Twin is not a medical device, has not been cleared by any regulator, and must not be used to make clinical decisions. Do not enter identifiable patient data.

---

## Features

| Module | What it does |
|---|---|
| **Patient digital twins** | Age, sex, size (IBW/ABW/LBW/BSA), renal function (Cockcroft–Gault, CKD-EPI 2021, Schwartz), Child–Pugh, pregnancy, heart failure, smoking/alcohol, CYP2D6/2C19/2C9/3A5 phenotypes, VKORC1, HLA risk alleles, conditions, allergies. Templates for elderly CKD, cirrhosis, pregnancy, paediatrics and obesity. |
| **Medical history & retrospective analysis** | Record past surgeries (bariatric, hepatectomy, transplant, CABG…) and medication courses. The twin reconstructs what they already did: residual drug levels, enzyme induction/inhibition carry-over, cumulative cardiotoxic/nephrotoxic dose versus thresholds, altered absorption and hepatic capacity, and an organ-burden map. |
| **Multi-drug PK/PD simulator** | Up to six concurrent medicines (oral, IV bolus, infusion, SC; mg, mg/kg, mg/m²; loading doses; staggered starts). Concentration–time curves with therapeutic and toxic windows, effect-site pharmacodynamics, QTc, metabolic-pathway activity over time, an animated organ-level body map, PK metrics, CSV export, printable report and automatic dose individualisation. |
| **Interaction & PGx checker** | Curated major interactions, mechanism-based CYP/P-gp/renal interactions, QT stacking, serotonergic, CNS-depressant, bleeding, nephrotoxic and hyperkalaemia combinations, CPIC-based pharmacogenomic alerts, renal/hepatic/pregnancy/allergy/Beers checks, interaction matrix. |
| **Bayesian precision dosing (TDM)** | MAP Bayesian estimation of individual clearance and volume from measured levels (log-normal priors, combined residual error, Nelder–Mead), credible interval, fit diagnostics and forecast of the recommended regimen — the approach used by MIPD tools. |
| **Virtual clinical trials** | Reproducible virtual populations (seeded) with covariate distributions and ancestry-specific genotype frequencies; up to three paired arms; percentile bands, probability of target attainment, toxic exposure, histograms, subgroup analysis and subject-level export. Runs in a Web Worker. |
| **OR & anaesthesia simulator** | Marsh / Schnider propofol and Minto remifentanil three-compartment models with effect-site TCI (plasma or effect targeting), BIS via the Bouillon response surface, MAP/HR responses to stimulation and blood loss, fluids and vasopressors, three scored surgical scenarios with debrief. |
| **Drug discovery sandbox** | Lipinski/Veber drug-likeness, BCS class, FDA 2005 HED → MRSD starting dose, allometric human PK prediction, efficacious-dose projection and SAD/MAD cohort simulation with modified-Fibonacci escalation. |
| **Clinical training** | Case-based learning with live simulations, immediate feedback and explanations, server-side scoring and a leaderboard. |
| **Drug library & methods** | 38 medicines with PK, PD, interactions, PGx, organ effects, monitoring and references; a Models & validation page that recomputes literature benchmarks live. |

### Model validation (computed by the test suite and live in the app)

| Benchmark | Literature | Model |
|---|---|---|
| Atorvastatin + clarithromycin AUC ratio | ≈ 4.5× | 5.5× |
| Theophylline + ciprofloxacin | 1.5–2.5× | 2.0× |
| Digoxin + amiodarone (steady state) | ≈ 1.7–2× | 1.8× |
| Lamotrigine + valproate | ≈ 2× | 2.4× |
| Midazolam IV + rifampicin | 0.2–0.5× | 0.28× |
| Metoprolol, CYP2D6 PM | 4–5× | 3.6× |
| Tacrolimus, CYP3A5 expresser | ≈ 0.5× | 0.56× |
| Vancomycin 1 g q12h AUC₂₄ | 400–550 | 426 |
| Carbamazepine t½ after autoinduction | 12–17 h | 15.7 h |

## Architecture

```
packages/engine   TypeScript PK/PD engine (no dependencies) — shared by browser and server
  drugs.ts          38-drug parameter database
  physiology.ts     covariates, renal/hepatic function, pharmacogenomics, procedures
  pk.ts             multi-drug ODE simulator (RK4) with dynamic DDI, MM kinetics, PD, QTc, organ load
  interactions.ts   clinical decision-support rules
  population.ts     virtual populations & trials (seeded PRNG)
  dosing.ts         dose optimisation, Nelder–Mead, Bayesian MAP
  anesthesia.ts     TCI models, BIS/haemodynamics, scenarios & scoring
  discovery.ts      drug-likeness, FIH dose, allometry, SAD/MAD
  history.ts        retrospective reconstruction of past exposure
  cases.ts          training cases and scoring
server            Express 5 + SQLite (node:sqlite) API, serves the built SPA
web               React 19 + Vite + Tailwind 4 + Recharts SPA
```

Simulations run client-side for instant feedback (and in a Web Worker for trials); the server persists twins, experiments, compounds and training results, provides a bounded server-side `/api/simulate` endpoint, and enforces authentication and authorisation.

## Security

- **Passwords:** scrypt (N=2¹⁵), NIST-style length + blocklist policy, constant-time comparison, dummy hashing to avoid user enumeration by timing.
- **Sessions:** 256-bit random opaque tokens stored only as SHA-256 hashes; `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefixed cookies; idle and absolute expiry; rotation on login; all other sessions revoked on password change; session list and remote sign-out.
- **2FA:** RFC 6238 TOTP with ±1 step window and replay protection; seeds encrypted at rest with AES-256-GCM.
- **CSRF:** SameSite=Strict + double-submit token + `Origin` verification + JSON-only bodies.
- **Brute force:** per-IP rate limits (auth, simulation and global) and per-account lockout.
- **Headers:** strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), HSTS (preload), nosniff, COOP/CORP, Referrer-Policy, Permissions-Policy, no `X-Powered-By`.
- **Data access:** every query is scoped to the authenticated user (IDOR-safe); RBAC (student / clinician / researcher / admin); admin cannot be self-assigned; demo account cannot change credentials.
- **Input handling:** zod schemas with physiological bounds on every endpoint, parameterised SQL only, 512 KB body limit, ID format validation, CSV formula-injection neutralisation, server-side training scoring.
- **Operations:** audit log of security events, structured request logs without bodies, non-root read-only container, CodeQL and Dependabot.

The automated suite includes attack tests for CSRF, IDOR, privilege escalation, SQL-injection payloads, forged cookies, lockout, oversized/malformed bodies, prototype pollution, TOTP replay and session revocation. See [SECURITY.md](SECURITY.md).

## Getting started

### One command

```bash
git clone https://github.com/MIsmail2524/MedCare.git && cd MedCare && ./install.sh
```

`install.sh` checks the platform, installs missing `git`/`curl`, installs Node.js 22 via nvm when needed (no sudo), creates `.env` with a random `APP_SECRET`, runs `npm ci`, builds, runs the tests and starts the app on http://localhost:8080.

| Option | Effect |
|---|---|
| `--dev` | Hot-reload servers (API :8080, web :5173) |
| `--docker` | Build and run with Docker Compose |
| `--no-start` | Install and build only |
| `--skip-tests` | Skip the test suite |
| `--port 3000` | Serve on another port |
| `--dir PATH` | Clone/install into `PATH` when run outside the repo |

The script is idempotent: re-running it keeps your `.env` and database (`data/`). Linux and macOS are supported; on Windows use WSL.

### Manual

Requirements: Node.js ≥ 22.13.

```bash
npm ci
npm run build          # engine → web → server
npm test               # 56 engine + API/security tests
npm start              # http://localhost:8080
```

Development with hot reload (API on :8080, Vite on :5173 proxying `/api`):

```bash
npm run dev
```

A shared demo account is seeded automatically: **demo@medcare.dev / MedCare-Demo-2026** (credential changes are disabled for it). Set `SEED_DEMO=false` to disable.

## Deployment

### Docker

```bash
cp .env.example .env    # set APP_SECRET (openssl rand -hex 32), ADMIN_EMAIL/ADMIN_PASSWORD
docker compose up -d --build
```

The image is multi-stage, runs as the unprivileged `node` user, has a health check, and stores the SQLite database on the `/data` volume.

### Render

`render.yaml` is a ready blueprint (Docker runtime, persistent disk, generated `APP_SECRET`). Any container host (Fly.io, Railway, AWS ECS, Azure Container Apps) works: terminate TLS at the proxy, set `TRUST_PROXY=1`, keep `COOKIE_SECURE=true`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APP_SECRET` | — (required in production) | Key material for encrypting TOTP seeds |
| `COOKIE_SECURE` | `true` in production | Secure / `__Host-` cookies and HSTS |
| `TRUST_PROXY` | `0` | Reverse-proxy hops for client IP |
| `DATABASE_PATH` | `medcare.db` | SQLite file |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Bootstrap administrator |
| `ALLOW_REGISTRATION` | `true` | Open sign-up |
| `SEED_DEMO`, `DEMO_PASSWORD` | `true` | Shared demo account |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `120`, `12` | Session lifetime |

## UX and accessibility

Built around Nielsen’s heuristics and WCAG 2.2 AA: instant feedback and visible system status, clinical units and terminology, presets and templates (recognition over recall), validation with inline error messages, confirmation for destructive actions and unsaved-change guards, keyboard-navigable tabs, dialogs and a Ctrl/⌘-K command palette, skip link, visible focus rings, ARIA live regions, colour-blind-safe validated chart palette with labels and tables (never colour alone), light/dark/system themes, reduced-motion support and responsive layouts down to 375 px.

## Scientific references

Rowland & Tozer, *Clinical Pharmacokinetics and Pharmacodynamics*; Winter, *Basic Clinical Pharmacokinetics*; FDA *Drug Interaction Table* and *Maximum Safe Starting Dose* guidance (2005); CPIC guidelines; Rybak et al. 2020 (vancomycin); Inker et al. NEJM 2021 (CKD-EPI); Marsh 1991, Schnider 1998, Minto 1997, Bouillon 2004 (anaesthesia); Swain et al. 2003 (anthracycline cardiotoxicity).
