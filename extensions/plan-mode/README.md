# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Built-in write tools disabled**: Disables edit/write while preserving other active tools
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Durable plan files**: Saves full plans under `<agent-dir>/plans/<project>/`
- **Headless support**: Background agents save plans without requiring a dialog
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/plan-execute` - Execute the extracted plan and track its progress
- `/plan-refine` - Refine the extracted plan in an interactive editor
- `/todos` - Show current plan progress and saved file path
- `Ctrl+Shift+R` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. The full plan is saved under `<agent-dir>/plans/<project>/` (normally
   `~/.pi/agent/plans/<project>/`)
5. Choose "Execute the plan" when prompted
6. During execution, the agent marks steps complete with `[DONE:n]` tags
7. Progress widget shows completion status

In inbox/orchestrator background runs, the agent cannot open an interactive
selection dialog. It still extracts and saves the plan, then leaves the session
waiting for you. Take over the session and run `/plan-execute` or
`/plan-refine`.

## How It Works

### Plan Mode (Read-Only)
- Built-in edit/write tools disabled
- Other active tools remain available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

### Headless / Orchestrator Mode
- Plan extraction and file saving work when `ctx.hasUI` is false
- The saved todo state is restored when the session is taken over
- `/plan-execute` and `/plan-refine` replace the unavailable selection dialog

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
