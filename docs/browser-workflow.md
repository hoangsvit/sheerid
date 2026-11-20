# Verification browser workflow

The application first queries the current remote status using HTTP. It then selects the appropriate next step:

1. **Personal-information stage:** launch the Camoufox browser, identify eligible form fields and enter details supplied by the authorized user.
2. **Document stage:** if requested by the service, read an original PNG, JPEG or PDF document from the configured source and submit it using the API workflow.
3. **Manual stage:** let the user handle any interactive human verification, email confirmation or sign-in required by the provider.
4. **Review stage:** poll the status endpoint while the verification is pending.
5. **Terminal stage:** report the result or a structured error without claiming a positive verification unless the provider reports it.

The workbench avoids automatically generating or altering documents, and it does not solve interactive human verification challenges.

## Form handling

The browser adapter looks up supported fields and options, validates matching choices, and stops rather than guessing when a target field or institution choice is ambiguous. Configuration settings include browser locale, timeouts, selectors, and whether to keep the browser open.

## Queue and cancellation

Each queued task has a `verificationId`. Canceling a running task stops subsequent automated actions and waits for cleanup before releasing its concurrency slot. Resuming a stopped task performs a status preflight rather than blindly submitting again.

## Local development

Run `npm test` to exercise mocked API and local fixtures. Use Camoufox locally for the browser-based test fixtures. Do not run integration tests against third-party verification services without explicit authorization.
