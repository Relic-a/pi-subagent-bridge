# Security Policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue for suspected vulnerabilities or exposed credentials.

Include reproduction steps, affected versions, and the potential impact. You
should receive an initial response within seven days.

## Local data

The bridge launches local coding-agent processes and stores run metadata in a
local SQLite database. Review the security notes in the README before using it
with sensitive repositories. Tool arguments are redacted before persistence;
final-answer redaction is opt-in with `PI_BRIDGE_REDACT_FINAL_ANSWERS=1`.
