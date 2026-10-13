# Plugin packaging and ChatGPT upload

Bridge is distributed as a portable Agent Plugins package that combines the repository skills with the already-registered Bridge MCP app.

## Canonical package contents

The upload artifact must contain exactly one plugin root. The canonical Bridge artifact puts these files at the ZIP root:

```text
plugin.json
.app.json
skills/
  runner-bridge/SKILL.md
  continuous-github-development/SKILL.md
  bridge-project-onboarding/SKILL.md
```

The repository contains more source, tests, migrations and runtime files, but they are not required in the ChatGPT upload artifact.

## Build the upload ZIP

From the repository root:

```bash
npm install
npm run plugin:package
```

The script writes:

```text
dist/runner-bridge-plugin-<version>.zip
```

The script also validates that every registered app mapping uses an identifier format accepted by the ChatGPT Upload plugin validator.

## Registered Bridge app mapping

The export has no preconfigured App. Set BRIDGE_APP_ID to the identifier of your own connected App before packaging. The following shows the shape only; the placeholder is not a registered App:

```json
{
  "apps": {
    "bridge": {
      "id": "asdk_app_REPLACE_WITH_YOUR_APP_ID",
      "required": true
    }
  }
}
```

Do not prepend `plugin_` to this stored `.app.json` value for the current upload flow. Some product surfaces and documentation may expose other identifier namespaces; use the identifier actually returned/accepted for the registered App on the target surface.

## Why not rely on GitHub's generic Download ZIP?

OpenAI's plugin archive rules permit a single plugin root either at the ZIP root or inside one top-level directory. In principle a clean GitHub source ZIP can satisfy that rule.

For Bridge, however, the canonical upload artifact is the deterministic package produced by `npm run plugin:package`. It is smaller, contains only plugin-relevant files, preserves known-good ZIP paths, and avoids browser/download corruption or unrelated repository content.

## Release discipline

When changing plugin-visible content:

1. update the skills or app mapping;
2. bump `plugin.json.version`;
3. run `npm run plugin:package`;
4. upload the generated ZIP;
5. verify the plugin page shows the Bridge app and all expected skills;
6. install and test in a fresh chat.

Do not change Bridge execution authority merely to make plugin packaging easier.
