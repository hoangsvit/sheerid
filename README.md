# Verification Workbench

A Node.js local workbench for **authorized educational verification workflow testing**. It combines a local web interface, a task queue with saved history, browser form interaction via Camoufox, and verification status checks over HTTP.

> **Permitted use:** Use only with accounts, student details and documents you are authorized to provide. Do not impersonate students, submit fabricated evidence, bypass eligibility reviews or use this project to obtain benefits you are not eligible for. It is not affiliated with SheerID or any institution and cannot guarantee verification.

## Features

- Enter a verification URL, first and last name, date of birth and optional proxy.
- Add tasks to a queue; view progress, review recent events, cancel, resume or delete finished tasks.
- Read verification state before choosing the browser or document-upload flow.
- Use Camoufox for supported form-interaction steps; interactive human challenges remain manual.
- Submit original PNG, JPEG or PDF evidence you legitimately possess, without generating or modifying proof.
- Open the local web interface without a password; origin checks and an automatic request token protect web requests.
- Configure task concurrency; the default is **1**. Jobs, request results and recent activity are saved locally and restored after restart.

## Requirements

- Node.js **22.15 or newer**
- npm
- Camoufox installation for browser-assisted tasks

## Quick start

```bash
git clone https://github.com/hoangsvit/sheerid.git
cd sheerid
npm ci
npm run browser:install
```

Create your local configuration:

**Linux or macOS**
```bash
cp config/sheerid.example.json config/sheerid.local.json
```

**Windows PowerShell**
```powershell
Copy-Item config/sheerid.example.json config/sheerid.local.json
```

Edit `config/sheerid.local.json`. Set the actual country, institution, permitted email domain, and document source for your authorized testing. The example is deliberately not filled with real student information. Only one of `document.path` or `document.url` may be supplied.

Start the web interface:

```bash
npm run web
```

Open **http://127.0.0.1:8787**. The page connects automatically without a password. Remote deployments use HTTPS and access controls supplied by the reverse proxy or network.

## Web configuration and behavior

- The task form requires `url`, `firstName`, `lastName`, and `birthDate`; `proxy` is optional.
- Verification links need a valid `verificationId`. The email address is constructed from the entered name and configured `data.organization.emailDomain`. Use only a real address you control.
- A blank proxy field forces a direct connection; it does not inherit system proxy settings.
- `web.concurrency` controls the number of active tasks and defaults to 1.
- A task uses its `verificationId` as a unique key across restarts. Submitting the same ID selects the saved task. A finished task may be explicitly deleted and submitted again as a new task.
- Review waits and manually operated browsers may continue occupying a task slot.
- The web interface polls while tasks are active and stops polling when idle.
- **Saved jobs** retains creation times, results, recent activity and a request history in `<artifactsDir>/web-jobs.json` (default `.runs/web-jobs.json`). Form names, birth dates, full verification URLs and proxy credentials are not stored in this history or returned by the job history endpoints.
- Select a finished job and use **Check status** to read its existing verification once. This also works for failed jobs and after restarting the service; it does not open a browser, submit information or upload documents. Each check appears in the job's request history, preserving earlier results.
- HTTP 429 adds a local cooldown of at least 60 seconds, or the server's longer `Retry-After`. The button becomes available when the cooldown expires; no automatic API retry is scheduled. This is a minimum request spacing, not a promise that the provider's limit has expired.
- Task execution state and provider verification state are separate. HTTP failures preserve `httpStatus` and bounded provider codes. A JSON error response confirms `currentStep` only when its fields validate and `verificationId` matches the requested job; `stateConfirmed` and `stateCheckedAt` identify that observation. Responses without enough identity/state information retain diagnostic codes under `responseErrorIds` / `responseRejectionReasons` and remain unconfirmed. Full response bodies are never saved.
- If a check fails without a validated state, the UI marks the current verification state unconfirmed and shows the last confirmed response with its receipt time. `lastKnownStep` / `lastKnownAt` are historical context. `lastCheckedAt` records a check attempt, including failures. Provider error codes in a validated terminal response are displayed even when the HTTP status is 429; these responses are not automatically retried.
- Restarting restores unfinished jobs as interrupted. They remain idle until you check status. **Resume** is available only for stopped submission tasks whose original settings are still in memory. Restored jobs use a direct connection for status checks; custom proxy credentials are not restored.
- One web service owns each history file. Invalid history prevents startup instead of silently discarding it. Stop the existing service before starting another against the same history.
- Jobs created before this feature are not automatically recoverable: older `.runs/<runId>.json` files do not contain the verification ID needed to reconstruct a job.
- **Fill saved data** fills `data.firstName`, `data.lastName` and `data.birthDate` from your local configuration (for example, details you transcribed from your document). It reads the current settings each time and does not queue a task. Missing or invalid details show an error; the button never generates random identities.

## API overview

The web API is locally hosted and has no application password or login cookie. Write requests require `X-Local-Token`, obtained automatically by the page from `GET /api/session`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Retrieve the session token |
| `GET` | `/api/form-defaults` | Retrieve only the configured first name, last name and birth date |
| `GET` | `/api/jobs` | List queue and task summaries |
| `POST` | `/api/jobs` | Queue a task |
| `GET` | `/api/jobs/:verificationId` | Read a task and its event history |
| `POST` | `/api/jobs/:verificationId/cancel` | Stop a task |
| `POST` | `/api/jobs/:verificationId/resume` | Resume a stopped task |
| `POST` | `/api/jobs/:verificationId/check-status` | Queue one read-only status check for a saved job |
| `DELETE` | `/api/jobs/:verificationId` | Delete a finished task |

The browser workflow and HTTP API are intended for controlled, authorized scenarios. See [browser workflow](docs/browser-workflow.md) and [deployment instructions](docs/DEPLOYMENT.md).

## Development and tests

```bash
npm test
```

Most tests use local fixtures and mocked responses rather than submitting data to a verification provider. Browser-level tests are skipped unless Camoufox is installed. GitHub Actions checks the test suite on Node.js 22 and 24.

## License

Licensed under the **ISC License**. See [LICENSE](LICENSE) for the required copyright and permission notice.

See [DISCLAIMER.md](DISCLAIMER.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md). Third-party services, dependencies and verification providers have their own terms.
