# Agent Notes

## Tech Stack

The application we are working on uses the following tech stack:

- TypeScript
- Node.js 22+
- Bun 1.2+
- TypeBox
- Biome
- Vitest

## TypeScript General Guidelines

## Core Principles

- Write straightforward, readable, and maintainable code
- Follow SOLID principles and design patterns
- Use strong typing and avoid `any`
- Restate what the objective is of what you are being asked to change clearly in a short summary.
- Utilize Lodash, 'Promise.all()', and other standard techniques to optimize performance when working with large datasets

## Coding Standards

### Naming Conventions

- Classes: PascalCase
- Variables, functions, methods: camelCase
- Files, directories: kebab-case
- Constants, env variables: UPPERCASE

### Functions

- Use descriptive names: verbs & nouns (e.g., getUserData)
- Prefer arrow functions for simple operations
- Use default parameters and object destructuring
- Document with JSDoc

### Types and Interfaces

- For boundary data, prefer a TypeBox schema plus an inferred TypeScript type.
- Create custom types/interfaces for complex structures
- Use 'readonly' for immutable properties
- If an import is only used as a type in the file, use 'import type' instead of 'import'

## Code Review Checklist

- Ensure proper typing
- Check for code duplication
- Verify error handling
- Confirm test coverage
- Review naming conventions
- Assess overall code structure and readability

## Documentation

- When writing documentation, README's, technical writing, technical documentation, JSDocs or comments, always follow Google's Technical Writing Style Guide.
- Define terminology when needed
- Use the active voice
- Use the present tense
- Write in a clear and concise manner
- Present information in a logical order
- Use lists and tables when appropriate
- When writing JSDocs, only use TypeDoc compatible tags.
- Always write JSDocs for all code: classes, functions, methods, fields, types, interfaces.

## Git Commit Rules

- Make the head / title of the commit message brief
- Include elaborate details in the body of the commit message
- Always follow the conventional commit message format
- Add two newlines after the commit message title

## Repository Rules

- Run `pnpm check` before handing off meaningful code changes.
- Use Biome formatting: 2-space indentation, 100-column line width, double quotes,
  semicolons, and organized imports.
- Keep TypeScript strict. Prefer `unknown` plus parsing/narrowing over `any`.
- Use `@repo/*` package imports. Do not deep-import another package's `src`.
- Apps may depend on packages. Packages must not depend on apps.

## Testing Philosophy

| Good Tests | Bad Tests |
| --- | --- |
| Exercise real code through public interfaces | Mock internal collaborators |
| Describe WHAT the system does | Test HOW it's implemented |
| Survive internal refactors unchanged | Break on refactoring without behavior change |
| Read like specifications | Test the shape of data structures |
| Focus on user-facing behavior | Verify through external means (DB queries, call counts) |
