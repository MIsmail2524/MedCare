# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Security → Report a vulnerability** (private advisory) on this repository. Do not open public issues for security problems. We aim to acknowledge within 72 hours.

## Threat model summary

| Threat | Mitigation |
|---|---|
| Credential stuffing / brute force | scrypt hashing, per-IP rate limiting, per-account lockout (5 failures → 15 min), optional TOTP 2FA |
| Session hijacking | Opaque random tokens stored hashed, `HttpOnly` + `Secure` + `SameSite=Strict` + `__Host-` cookies, idle/absolute expiry, rotation on login, revoke-all on password change |
| CSRF | SameSite=Strict, double-submit token, `Origin` check, JSON-only content type |
| XSS | React output escaping, strict CSP without inline scripts, no `dangerouslySetInnerHTML` |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options` |
| SQL injection | Parameterised statements only; zod validation and ID allow-lists |
| IDOR / privilege escalation | All queries scoped by `user_id`; RBAC; admin role cannot be self-assigned; admins cannot demote or disable themselves |
| User enumeration | Generic login errors, dummy hashing for unknown accounts |
| Denial of service | Body size limit, bounded simulation inputs, rate limits, request/header timeouts |
| Secret disclosure | TOTP seeds AES-256-GCM encrypted; no secrets in logs; production refuses to start without `APP_SECRET` |
| Spreadsheet formula injection | CSV export neutralises leading `= + - @` |
| Supply chain | Lockfile, `npm audit` in CI, Dependabot, CodeQL |

## Data handling

MedCare Twin is designed for synthetic or de-identified data only. It is not certified for storing protected health information (HIPAA/GDPR special-category data). Users can export all of their data as JSON and permanently delete their account from Settings.

## Operational recommendations

- Terminate TLS at a reverse proxy and set `TRUST_PROXY` to the number of hops.
- Generate `APP_SECRET` with `openssl rand -hex 32` and store it in a secret manager.
- Back up the `/data` volume; the SQLite database uses WAL mode.
- Disable the shared demo account (`SEED_DEMO=false`) for private deployments.
