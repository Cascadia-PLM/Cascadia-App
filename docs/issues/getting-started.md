# Issues: Getting Started

Issues discovered during research for the getting-started documentation.

## No .nvmrc or engines field for Node.js version

- **Severity**: minor
- **Area**: config
- **Description**: There is no `.nvmrc`, `.node-version`, or `engines` field in `package.json` to specify the required Node.js version. The project uses ESM (`"type": "module"`), modern TypeScript features, and dependencies that require Node.js 20+, but this is not explicitly declared.
- **Location**: `package.json` (missing `engines` field), project root (missing `.nvmrc`)
- **Suggestion**: Add `"engines": { "node": ">=20.0.0" }` to `package.json` and/or create a `.nvmrc` file with `22` (the recommended LTS version).
