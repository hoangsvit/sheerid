# Security

## Reporting

Please report vulnerabilities privately to the repository maintainers when possible. Do not publish credentials, real verification links, student records or exploitable details in public issues.

## Operational guidance

- Run the web workbench on `127.0.0.1` unless an authenticated HTTPS reverse proxy is configured.
- Never commit `config/sheerid.local.json`, `.env`, student documents or `.runs/`.
- Limit access to trusted users and keep Node.js and dependencies up to date.
- Review the code and third-party dependencies before running them.
- Follow provider terms, privacy requirements and authorized-testing boundaries.

The local web API connects without a password prompt and implements origin validation and an automatic write-request token. Remote access controls belong to the reverse proxy or network.
