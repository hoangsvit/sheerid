# Security

## Reporting

Please report vulnerabilities privately to the repository maintainers when possible. Do not publish credentials, real verification links, student records or exploitable details in public issues.

## Operational guidance

- Run the web workbench on `127.0.0.1` unless an authenticated HTTPS reverse proxy is configured.
- Change the upstream example password using `ONE_WEB_PASSWORD`; never deploy with a known password.
- Never commit `config/sheerid.local.json`, `.env`, student documents or `.runs/`.
- Limit access to trusted users and keep Node.js and dependencies up to date.
- Review the code and third-party dependencies before running them.
- Follow provider terms, privacy requirements and authorized-testing boundaries.

The local web API implements password checks, session cookies, origin validation and a write-request token. These protections are not a substitute for a properly secured deployment.
