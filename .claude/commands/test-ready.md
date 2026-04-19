---
description: Validate code is ready for commit — lint + tests + optional E2E. Use --scoped for changed-only, otherwise full suite.
argument-hint: [--scoped for changed files only | --skip-e2e to skip E2E tests]
allowed-tools: Bash(npm run*), Bash(npx vitest*), Bash(npx playwright*), Bash(git *), Bash(grep *), Bash(node .claude/hooks/*), Read, Grep
---

# Pre-Commit Validation

Runs validation before commit. All checks must pass.

## Arguments

$ARGUMENTS

## Modes

- **Default (full):** Lint + full unit suite + tier-1 E2E if UI files changed. Run this before the final commit.
- **`--scoped`:** Lint + vitest against tests related to the current diff only. Much faster; use during iteration.
- **`--skip-e2e`:** Skip E2E even if UI files changed.

## Validation steps

### Step 1: Debug-code sweep

```bash
grep -rn "console\.log\|\.only\|\.skip\|debugger" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "__tests__" | head -20
```

List findings and **STOP** — these must be removed before proceeding.

### Step 2: Lint

```bash
npm run lint
```

If lint fails, fix the issues and re-run this command. The pre-commit hook should auto-fix most format/import issues — if `npm run lint` surfaces unfixable ones, they're real.

### Step 3: Tests

**If `--scoped`:**

Run vitest only against tests related to the diff. Two sources:

```bash
# a) Co-located tests for changed source files
CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -E "^src/.*\.(ts|tsx)$" | grep -v "\.test\.")
for file in $CHANGED; do
  base="${file%.*}"
  ext="${file##*.}"
  test_file="${base}.test.${ext}"
  if [ -f "$test_file" ]; then
    npx vitest run "$test_file"
  fi
done

# b) Directly-changed test files
git diff --name-only HEAD 2>/dev/null | grep "\.test\." | xargs -r npx vitest run
```

**Otherwise (full):**

```bash
npm run test
```

On failure:

1. Identify which tests failed
2. Diagnose: code bug or test bug?
3. Fix the issue
4. Re-run the specific failing test: `npx vitest run <path>`
5. Once fixed, re-run the suite at the same scope

### Step 4: E2E smoke tests

Skip if `--skip-e2e` OR `--scoped` OR no UI/route files changed.

Otherwise, if changes include files in `src/routes/` (non-api) or `src/components/`:

```bash
npm run test:e2e -- --grep @tier1
```

### Step 5: Update session status (if hooks installed)

```bash
test -f .claude/hooks/update-session.mjs && echo "hooks-installed" || echo "no-hooks"
```

If hooks are installed and all checks passed:

```bash
node .claude/hooks/update-session.mjs pass
```

If any check failed:

```bash
node .claude/hooks/update-session.mjs fail "Description of failure"
```

## Final report

**If all checks pass:**

- Report: "Validation passed. Ready for commit."
- Do NOT commit automatically.

**If any check fails:**

- List what failed with file paths and line numbers
- Suggest specific fixes
- Tell user to fix issues and re-run (`/test-ready` or `/test-ready --scoped`)
- Do NOT offer to commit
