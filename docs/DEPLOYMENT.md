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
ONE_WEB_PASSWORD='replace-with-a-long-unique-secret' npm run web
```

The default address is `http://127.0.0.1:8787`. Do not expose the port to the public Internet.

## HTTPS reverse proxy

If remote access is explicitly required, place the app behind a TLS-terminating reverse proxy, protect it with network restrictions and a strong `ONE_WEB_PASSWORD`, and configure the external HTTPS origin. Review `deploy/nginx.conf.example`, `deploy/.env.web.example`, and `deploy/one-web.service`.

Relevant environment variables:

| Variable | Purpose |
| --- | --- |
| `ONE_WEB_PASSWORD` | Required strong access password for non-local use |
| `ONE_WEB_HOST` | Listener, normally `127.0.0.1` |
| `ONE_WEB_PUBLIC_ORIGIN` | Valid HTTPS public origin when publishing through a trusted reverse proxy |

Only bind `0.0.0.0` with a valid configured HTTPS public origin and securely restricted access. The origin must be an HTTPS URL without embedded credentials, path, query string or fragment.

## Operations

- `npm test`: run the automated suite.
- `npm run web`: launch the web workbench.
- `npm run browser:install`: install the browser adapter.
- `npm start`: run the command-line workflow.

Task state lives in memory. Restarting the service cancels in-progress and queued jobs rather than restoring them. Protect the local config, upload files, logs and any proxy secrets.
