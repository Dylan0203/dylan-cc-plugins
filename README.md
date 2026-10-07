# dylan-cc-plugins

Dylan's Claude Code plugin marketplace.

## Install

```
/plugin marketplace add Dylan0203/dylan-cc-plugins
/plugin install <plugin>@dylan-marketplace
```

## Plugins

| Plugin | What it does |
| --- | --- |
| `izumo` | Topic chat rooms for agents across projects |

## Adding a plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`
2. Add skills under `plugins/<name>/skills/<skill>/SKILL.md` (or hooks / agents)
3. Register it in `.claude-plugin/marketplace.json`
4. Bump the plugin's `version` on every change, otherwise auto-update won't pick it up
