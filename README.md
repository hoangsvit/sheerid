# Verification Workbench

A Node.js local workbench for **authorized educational verification workflow testing**. It combines an authenticated web interface, an in-memory task queue, browser form interaction via Camoufox, and verification status checks over HTTP.

> **Permitted use:** Use only with accounts, student details and documents you are authorized to provide. Do not impersonate students, submit fabricated evidence, bypass eligibility reviews or use this project to obtain benefits you are not eligible for. It is not affiliated with SheerID or any institution and cannot guarantee verification.

## Features

- Enter a verification URL, first and last name, date of birth and optional proxy.
- Add tasks to a queue; view progress, review recent events, cancel, resume or delete finished tasks.
- Read verification state before choosing the browser or document-upload flow.
- Use Camoufox for supported form-interaction steps; interactive human challenges remain manual.
- Submit original PNG, JPEG or PDF evidence you legitimately possess, without generating or modifying proof.
- Protect the local web API with a password, session cookie, origin checks and a request token.
- Configure task concurrency; the default is **1**. Jobs and their histories live in process memory and are not automatically restored after restart.

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

Open **http://127.0.0.1:8787**. The local development password is `local-dev-only`. **Set a unique `WORKBENCH_WEB_PASSWORD` before use outside an isolated local test environment**. Do not expose the service publicly without HTTPS and proper access restrictions.

## Web configuration and behavior

- The task form requires `url`, `firstName`, `lastName`, and `birthDate`; `proxy` is optional.
- Verification links need a valid `verificationId`. The email address is constructed from the entered name and configured `data.organization.emailDomain`. Use only a real address you control.
- A blank proxy field forces a direct connection; it does not inherit system proxy settings.
- `web.concurrency` controls the number of active tasks and defaults to 1.
- A task uses its `verificationId` as an in-process unique key. A finished task may be deleted and submitted again as a new task.
- Review waits and manually operated browsers may continue occupying a task slot.
- The web interface polls while tasks are active and stops polling when idle.
- The `Fill sample data` button is for **mock/local UI demonstrations only**, not for submitting identities to a real service.

## API overview

The web API is locally hosted and uses an authenticated session or `X-Web-Password`. Write requests require `X-Local-Token`, available from `GET /api/session`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Retrieve the session token |
| `GET` | `/api/jobs` | List queue and task summaries |
| `POST` | `/api/jobs` | Queue a task |
| `GET` | `/api/jobs/:verificationId` | Read a task and its event history |
| `POST` | `/api/jobs/:verificationId/cancel` | Stop a task |
| `POST` | `/api/jobs/:verificationId/resume` | Resume a stopped task |
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
