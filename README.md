# claude-code-extras

Hooks, plugins and other bonus features I use for my Claude Code setups,
packaged as a plugin marketplace so they can be installed from any project.

```
/plugin marketplace add gmatiukhin/claude-code-extras
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [timings](plugins/timings) | Gives Claude a sense of elapsed time: idle gaps between turns, assistant turn duration split by tool vs model, and per-tool-call durations. |

Install one with `/plugin install <name>@claude-code-extras`.

## Conventions

Everything here is meant to be dropped into an unfamiliar machine and work:

- **No runtime dependencies.** Plugin logic is plain Node (Claude Code ships
  with it); no `jq`, no `npm install`.
- **Hooks never block.** Any internal failure exits 0 with no output.
- **Tests run with `node <plugin>/tests/run.mjs`**, no framework, no network.

## Development

```
claude plugin validate ./plugins/<name> --strict
node plugins/<name>/tests/run.mjs
```

To try a change before pushing, add the working tree as a local marketplace:
`/plugin marketplace add ./` from the repo's parent directory.
