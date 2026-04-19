---
description: Create a commit with summary and push to remote
argument-hint: [optional: specific commit message override]
allowed-tools: Bash(git *)
---

# Commit and Push

Create a well-formed commit and push to the remote repository.

## Current State

**Branch**:

```
$git branch --show-current
```

**Staged changes**:

```
$git diff --cached --stat
```

**Unstaged changes**:

```
$git diff --stat
```

## Instructions

### 1. Stage Changes (if needed)

If there are unstaged changes that should be committed, stage them:

```bash
git add <files>
```

### 2. Analyze Changes

Review the staged changes to understand what's being committed:

```bash
git diff --cached --name-status
```

### 3. Generate Commit Message

Create a commit message with this format:

```
<Short title - imperative mood, max 50 chars>

- <Change 1: what was added/modified/fixed>
- <Change 2>
- <Change 3>
```

**Title guidelines**:

- Use imperative mood: "Add feature" not "Added feature"
- Max 50 characters
- Capitalize first letter
- No period at end
- Examples: "Add pagination to parts list", "Fix login redirect bug", "Refactor ItemService for clarity"

**Summary guidelines**:

- One bullet per logical change
- Start with verb: Add, Fix, Update, Remove, Refactor, Improve
- Be specific but concise
- Group related changes
- Do NOT add a Co-Authored-By line

### 4. Create Commit

Use a HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
<title>

- <change 1>
- <change 2>
EOF
)"
```

### 5. Push to Remote

```bash
git push
```

If the branch has no upstream, set it:

```bash
git push -u origin <branch-name>
```

$ARGUMENTS

## After Completion

Report:

- Commit hash (short)
- Branch name
- Remote URL
- Summary of what was pushed
