# Project Guidelines

## Documentation

- Before changing code, inspect the documentation relevant to the affected behavior and search for existing references; do not rely on stale summaries or duplicate an existing contract.
- When a change affects API behavior, domain rules, configuration, deployment, or integrations, update the canonical document(s) in the same change. Keep examples and cross-references consistent with the implementation.
- Prefer extending an existing document over adding another one. Create a new document only when the subject is substantial and does not fit naturally in an existing guide.
- Use lowercase kebab-case for Markdown filenames (for example, `system-design.md`). When renaming or removing a document, update all links and references and check that no stale references remain.

## Canonical Documentation

- `api-contract.md`: API endpoints, payloads, responses, and errors.
- `system-design.md`: domain model, business rules, and system architecture.
- `deployment.md`: environment configuration, deployment, and operations.
- `whatsapp-templates.md`: WhatsApp configuration, templates, and messaging.
- `push-notifications.md`: Web Push requirements and integration.

Keep this list synchronized with the Markdown files in the repository.
