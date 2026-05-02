# Security Policy

## Supported versions

Only the latest `main` branch is supported. There is no LTS commitment — fixes
land on `main` and are picked up by anyone who pulls.

## Reporting a vulnerability

Please report security issues privately, not in public issues or pull requests.

**Preferred channel** — open a [GitHub Security Advisory](https://github.com/EliranEiluz/linkedin-job-finder/security/advisories/new). It keeps the report private until a fix is ready.

**Fallback** — email **eiluz.eliran7@gmail.com**.

When you report, please include:

- A description of the issue and the impact you observed.
- Steps to reproduce, or a minimal proof-of-concept.
- The commit SHA you tested against.
- Your environment (OS, Python version, Node version, browser if relevant).

Expected response time is best-effort, typically within a week. You will be credited in the fix commit / release notes unless you ask to remain anonymous.

## Scope

In scope:

- Code in this repository — backend Python, the React UI, the Vite dev middleware, the ctl JSON-CLIs, the OS scheduler integrations.

Out of scope:

- LinkedIn's own behavior or policies.
- Third-party LLM providers (Anthropic, Google, OpenAI, OpenRouter, Ollama).
- OS-level scheduler quirks outside our integration code.
- Issues in dependencies — please report those upstream first; we'll bump versions once a fix is published.
