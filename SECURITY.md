# Security

TalkQTE is in early development and has no supported release yet. Do not use it for sensitive meetings until capture, storage, permissions, and deletion have been implemented and reviewed.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, or meeting data in a public issue.

Use GitHub's private reporting option in the repository's Security tab when available. If it is not available, open an issue asking only for a private security contact, without vulnerability details or private data. Private reporting still needs to be enabled by the maintainer during repository setup.

Include affected versions or commits, a minimal reproduction using fictional data, impact, and any suggested mitigation. Do not attach real recordings, personal transcripts, tokens, or identifying logs.

## Development requirements

- Validate all commands and events across the frontend/native boundary.
- Grant only the native and filesystem capabilities a window needs.
- Keep transcription work off the UI thread and bound input queues and resource use.
- Store sensitive state outside the repository and exclude it from diagnostics.
- Review dependency and model licenses, provenance, and integrity before distribution.
- Use CI with read-only permissions by default. Never expose repository secrets to untrusted pull-request code.
- Review public artifacts for credentials and personal data before uploading them.
