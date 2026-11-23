# Deployment (Linux / reverse proxy)

This local application runs with Node.js 22.15+ and the optional Camoufox browser.

## Install

```bash
git clone https://github.com/hoangsvit/sheerid.git
cd sheerid
npm ci
npm run browser:install
cp config/sheerid.example.json config/sheerid.local.json
```

Configure a legitimate institution, country, email domain and authorized document source in `config/sheerid.local.json`. The file is deliberately ignored by Git.

## Local run

```bash
npm run web
```

The default address is `http://127.0.0.1:8787`. Do not expose the port to the public Internet.

## HTTPS reverse proxy

If remote access is explicitly required, place the app behind a TLS-terminating reverse proxy, provide access controls through that proxy or network restrictions, and configure the external HTTPS origin. The application connects without a password prompt. Review `deploy/nginx.conf.example`, `deploy/.env.web.example`, and `deploy/verification-workbench.service`.

Relevant environment variables:

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_WEB_HOST` | Listener, normally `127.0.0.1` |
| `WORKBENCH_WEB_PUBLIC_ORIGIN` | Valid HTTPS public origin when publishing through a trusted reverse proxy |

Only bind `0.0.0.0` with a valid configured HTTPS public origin and securely restricted access. The origin must be an HTTPS URL without embedded credentials, path, query string or fragment.

## Operations

- `npm test`: run the automated suite.
- `npm run web`: launch the web workbench.
- `npm run browser:install`: install the browser adapter.
- `npm start`: run the command-line workflow.

Job history is saved in `<artifactsDir>/web-jobs.json` and restored after restart. Interrupted tasks remain idle until explicitly checked. Protect the local config, upload files, logs and any proxy secrets.
