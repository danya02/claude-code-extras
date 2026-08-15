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
| [quota](plugins/quota) | Lets Claude see your Claude subscription usage: the 5-hour session window, the weekly windows and extra-usage credits, each as used% against elapsed%, so pace is visible rather than just the raw number. |

Install one with `/plugin install <name>@claude-code-extras`.

## Conventions

Everything here is meant to be dropped into an unfamiliar machine and work:

- **No runtime dependencies.** Plugin logic is plain Node (Claude Code ships
  with it); no `jq`, no `npm install`.
- **Hooks never block.** Any internal failure exits 0 with no output.
- **Tests run with `node <plugin>/tests/run.mjs`**, no framework, no network.
- **Bump `version` in `plugin.json` for every change you want installed.** The
  cache is keyed by version (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`),
  so an unchanged version leaves the old copy in place while the update reports
  success. Hooks are also bound when a session starts, so updating inside a
  session keeps the old code running until you start a new one.
- **Don't declare the standard paths in `plugin.json`.** `hooks/hooks.json` is
  loaded automatically; naming it in `manifest.hooks` too is a duplicate load,
  and Claude Code rejects the whole file — so the plugin silently runs with no
  hooks at all. `manifest.hooks` is only for *additional* hook files.

## Development

```
claude plugin validate ./plugins/<name> --strict
node plugins/<name>/tests/run.mjs
```

To try a change before pushing, add the working tree as a local marketplace:
`/plugin marketplace add ./` from the repo's parent directory.
