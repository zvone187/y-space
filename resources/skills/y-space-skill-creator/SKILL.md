---
name: y-space-skill-creator
description: Create a reusable agent skill managed by Y Space. Use when the user asks to create, scaffold, or write a skill, add repeatable agent instructions, or turn a recurring workflow into a shared or Y Space-only skill.
---

# Y Space Skill Creator

A skill is a folder containing a `SKILL.md` file with YAML frontmatter and Markdown instructions. Y Space manages shared skills in `.agents/skills` and app-only skills in the compatibility directory `.poracode/skills`.

## Decide location

- **Shared:** `.agents/skills/<name>/` so compatible agent tools can discover it.
- **Y Space only:** `.poracode/skills/<name>/` so Y Space injects it only into sessions launched by this app.
- **Global:** root the chosen directory in the user's home directory.
- **Project:** root it in the current project. When scope is unspecified inside a repository, default to project scope.

Do not write a Y Space-managed skill into provider-specific locations such as `.claude/skills`, `.codex/skills`, or `.gemini/skills`.

## Format

```markdown
---
name: <kebab-case-name>
description: <what it does and when it should trigger>
---

# <Title>

<Concrete instructions for the agent.>
```

The folder name and frontmatter name must match. Names use lowercase letters and digits separated by single hyphens, with at most 64 characters. Descriptions are non-empty and at most 1024 characters. Keep `SKILL.md` under 1 MB and place supporting files inside the same skill folder.

## Build and verify

1. Gather the purpose, derive a concise name, and determine availability and scope from the request.
2. Create the target folder and `SKILL.md`.
3. Write concrete steps, tool choices, safety boundaries, and important edge cases. Keep long reference material in linked sibling files.
4. Re-read the skill, validate the path and frontmatter, and ensure it contains no secrets or machine-specific absolute paths.
5. Tell the user the final path, availability, and scope. Mention that newly launched Y Space sessions discover it automatically.
