# dsh-effort-slider

[简体中文](README.md) | **English**

> A **sci-fi reasoning-effort slider** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a glowing core sits in the composer, and clicking it opens a floating energy bar. Above the highest level there is one more stop — **Ultra** — plus a **Lightning mode** that hands all the work to subagents, with the fleet's live tok/s shown next to it.

<p align="center"><img src="docs/images/panel-ultra.png" alt="Ultra level panel" width="620"></p>

---

## What this is

DSH's reasoning effort is normally a dropdown. This plugin turns it into an **energy bar**: levels are marked with ticks, and you can click, drag, or use the arrow keys; every level has its own visual feedback (light streaks, star trails, an incandescent core). The level names and the number of levels follow the current model's reasoning levels, and the whole widget hides itself when the model has none.

On top of that it does three more things:

| Feature | In one line |
| --- | --- |
| **Ultra level** | The 6th stop on the bar: selecting it **pins the reasoning effort to that model's highest real level (MAX)** and injects a "maximum rigor" English policy into the current session |
| **Lightning mode** | The switch in the top-right of the expanded panel (**off by default**): injects an English policy where the **parent agent only orchestrates and all the work is delegated to subagents** |
| **Fleet tok/s** | Live token throughput of this session's **subagents combined** (a full integer, never abbreviated with `k`) |

> ⚠️ This is not "more compute for the model". Ultra and Lightning are both **prompt-layer** controls: Ultra changes *how the work is verified*, Lightning changes *who does the work*. Lightning is the one that actually costs time and money — multi-agent work burns roughly **15×** the tokens of a single agent, which is exactly why it is off by default.

## Screenshots

| | |
| --- | --- |
| ![Ultra panel](docs/images/panel-ultra.png) | ![Skins](docs/images/skins.png) |
| Ultra: incandescent shell + fleet tok/s readout | Skins `holo` / `chrome` / `fluid` (default: fluid) |
| ![Lightning](docs/images/lightning.png) | ![Readout](docs/images/tok-rate.png) |
| Lightning: powered off is a white outline, powered on is a flowing gradient in the same hue | Readout: full integer, no shorthand, hidden entirely when there is no data |

## Feature details

### Ultra level
- The displayed levels are the model's real levels **plus one appended `Ultra` stop**; selecting Ultra still writes back **the highest real level (MAX)** id to the model catalog — `Ultra` never appears in a model catalog.
- It also injects an English **rigor contract** into the session (define acceptance criteria first, evidence over claims, adversarial second pass, root cause first, an explicit stop condition, and never bend the tests to fit the implementation).
- Invariant: **while the UI rests on Ultra, the actual reasoning effort is always MAX** (drag-and-release, clicking a tick, and restoring from the host after a reload all go through the same single write path).
- The level is spelled **`Ultra`**, not all-caps `ULTRA`.

### Lightning mode
- The orchestration contract it injects: the parent agent only plans / decomposes / dispatches / reviews / integrates; **split by boundary instead of cloning** the same prompt; **dispatch concurrently within one message**; child prompts must be self-contained (objective, acceptance criteria, exact files, constraints, output format, length cap); children write their artifacts to files and return a pointer instead of their whole output; and be honest about the budget (about 15× the tokens).
- The last paragraph of the policy hard-codes **recursion protection**: "if you are a delegated sub-agent, ignore this policy and do not dispatch further agents".
- Turning it off appends an OFF notice so that the policy already sitting in the history stops taking effect.

### Fleet tok/s
- Measures the token throughput of the **descendants (subagents) of the tracked session**: generation + input, **excluding cache reads**; the host subscribes to `agent/assistant-stream` and accumulates frame by frame, converting to tok/s over a 1.5s window.
- The UI shows a **full integer** (`12,840`, not `12.8k`); when there is no data the whole block is hidden rather than showing a fake number.

### Skins
- `holo` (holographic energy), `chrome` (liquid metal), `fluid` (fluid, **default**, with a particle fluid engine and star trails at the top level).
- `nebula` (interstellar nebula) was **retired at the author's request**: the code simply has it commented out of the skin array, while `SKIN_LABELS` and the whole set of CSS rules are still there. To bring it back, restore `"nebula"` in the array and adjust `DEFAULT_SKIN`.

## Install

Requires **DSH Desktop ≥ 2.0.9**. The repository ships a prebuilt `lib/client.js`, so it works right after installation — **no build step needed**.

```bash
# Recommended: install straight from GitHub
dsh plugin add github:yuhub233/dsh-effort-slider
```

Or download `dsh-effort-slider-<version>.zip` from [Releases](https://github.com/yuhub233/dsh-effort-slider/releases) (it contains the plugin already built), unzip it, and put the `dsh-effort-slider/` directory into `<DSH_HOME>/plugins/`.

Manual install: copy the repository directory into `<DSH_HOME>/plugins/` (on Windows by default `C:\Users\<you>\.dsh\plugins\`), then restart DSH. The plugin's own `cordis.patch.yml` is loaded automatically by the profile's bundle mechanism.

Uninstall: delete that directory (and remove the line if you registered it in the profile's `dsh.profile.bundles`), then restart DSH.

**Optional: install the 4 companion skills.** `skills/` bundles the playbooks that the Ultra / Lightning policies tell the agent to load (`dispatching-parallel-agents` / `subagent-driven-development` / `verification-before-completion` / `systematic-debugging`). DSH's skill discovery roots are `<project>/.dsh/skills`, `<project>/.agents/skills`, a preset's `customSkillDirs`, `~/.dsh/skills`, `~/.agents/skills`, and the harness's bundled directory — it **does not scan plugin directories**, so you have to copy them once:

```powershell
Copy-Item -Recurse -Force .\skills\dispatching-parallel-agents,`
  .\skills\subagent-driven-development,`
  .\skills\verification-before-completion,`
  .\skills\systematic-debugging `
  "$env:USERPROFILE\.dsh\skills\"
```

They are optional: the policy text is self-contained, and the skills are only a more detailed playbook.

## How it works

Two halves, each with its own job.

**Client half** (`client.js` + `effort-slider.css`)
- Registered through `window.__ModuleLoader__.load({ id, factory })`, with React pulled in via `require('react')`; it mounts into the composer's tool row (`conversation.input.right`).
- The source files cannot be read by the host directly: `node build.mjs` embeds the CSS into `lib/client.js` and asserts that "the embedded CSS is byte-identical to `effort-slider.css`".
- The panel is an absolutely positioned overlay: bar + ticks + readout + the Lightning switch; in the collapsed state it has exactly one child, the level name.

**Host half** (`index.mjs`)
- `GET/POST /plugins/dsh-effort-slider/preferences`: skin preference + client heartbeat (reported at each startup stage, used to decide whether the UI actually came up).
- `GET/PATCH /plugins/dsh-effort-slider/turbo`: the Lightning / Ultra switches, the fleet tok/s snapshot, and the policy text currently in effect.
- `inject.mjs` runs on the **`agent/pre-step` waterfall** to inject the policy text into the current step's model request, under three rules:
  1. call `await next()` first and append on top of the framework's own decision, never swallowing anyone else's;
  2. **filter exactly by session id** — subagents inherit their parent's scope, so "register by scope" is wrong and it has to be by id;
  3. **do not inject when the text has not changed** — the agent loop persists this step's messages one by one, so injecting every step would pile up duplicate entries in the history.
- State lives in `<DSH_HOME>/storages/effort-slider.json`: `{ skin, sessions: { "<sessionId>": { lightning, ultra } } }` (up to 40 sessions are kept).

## Data and privacy

- It only reads and writes that one JSON file on your machine; it **makes no external network requests** (no telemetry, no reporting).
- The policy text is injected only into **the one tracked session**, and only under the control of this plugin's own UI switches.

## Build and test

Only Node ≥ 22 is required (zero runtime dependencies).

```bash
node build.mjs              # embed CSS → lib/client.js, with a byte-level consistency assertion
npm test                    # all of the offline suites below
node smoke-test.mjs         # client: loader packaging, component rendering, skin/boundary regressions
node test/host.test.mjs     # host: endpoints, preference file, heartbeat, exceptions do not escape
node test/turbo.test.mjs    # turbo routes + policy injection (integration against a fake ctx)
node test/metrics.test.mjs  # tok/s metering (pure functions, including randomized stress)
node test/fluid.test.mjs    # fluid engine: density / column coverage / colour semantics / top-level ramp
node test/client-lifecycle.test.mjs # request deadlines, unmount cleanup, session races and subscriptions
```

The skin list and the default skin used by the tests are read out of the `client.js` source rather than hard-coded — when a skin is retired or the default changes, the tests follow the source.

## Layout

```
client.js            client half (UI + fluid engine + Ultra / Lightning / tok-s interactions)
effort-slider.css    all styling (CSS for all 4 skins is still present, including the retired nebula)
build.mjs            client.js + CSS → lib/client.js
lib/client.js        build artifact (committed, works right after installation)
index.mjs            host half (endpoints + heartbeat decision + wiring, fail-open)
inject.mjs           policy injection (agent/pre-step)
policy.mjs           the English policy bodies for Ultra and Lightning
turbo.mjs            turbo routes + session state + fleet metering wiring
metrics.mjs          pure-function tok/s accounting
test/                offline tests
skills/              the 4 upstream skills shipped with the package (optional; see skills/README.md)
TURBO-CONTRACT.md    frozen interface sheet (level model, endpoint contract, injection rules, evidence)
THIRD-PARTY.md       provenance and credits (which public work was reused, under what licence, and where)
```

## Known limitations

- Live fleet metrics use a bounded in-memory session index and lifecycle events instead of polling session history. Archived subagents are excluded from the member count. Updated plugin files take effect when the host next loads the plugin; running processes keep their loaded version.
- Turbo requests wait at most five seconds. If model selection has not returned after ten seconds, the slider releases its busy state and reports failure without cancelling the host operation. A later host success is still reflected by the actual directory state.

- **Package name = runtime identity**: `dsh-effort-slider` is at once the npm package name, the client bundle's registration id (`WebBootEntry.id`), the endpoint prefix (`/plugins/dsh-effort-slider/...`) and the `data-effort-slider` attribute value. **Renaming it requires four places to stay in sync**: `name` in `package.json`, `name` in the plugin's own `cordis.patch.yml`, the profile's `dsh.profile.bundles` entry, and the junction under `profiles/<profile>/node_modules` pointing at the plugin directory. If any one of them drifts, DSH throws `package identity is invalid for <name>` during profile assembly and refuses to start (a pitfall this project actually hit).
- The `nebula` skin is retired but its code remains; `DEFAULT_SKIN` and the skin whitelist (one copy each in `client.js` and `index.mjs`) have to be changed together, and the tests check that consistency.
- Ultra's sweep looks rather loud at high tok/s; the Lightning gradient animation relies on CSS `@property` and degrades to a static gradient on hosts that do not support it.
- The screenshots in this repository were taken from a verification harness (real artifact + real React); the grey annotation text outside the UI belongs to the harness, not to the plugin.

## Credits

The plugin's **code** is my own, but its interaction design and prompt policies are explicitly built on a few pieces of public work (itemised, with licences and usage, in [`THIRD-PARTY.md`](THIRD-PARTY.md)):

- **[`obra/superpowers`](https://github.com/obra/superpowers)** (MIT) — Lightning mode's dispatch and integration discipline, and Ultra's evidence and root-cause discipline, come from its 4 skills (`dispatching-parallel-agents` / `subagent-driven-development` / `verification-before-completion` / `systematic-debugging`). Those 4 skills **are bundled verbatim in this repository under [`skills/`](skills/)** (21 upstream files, unchanged byte for byte, MIT licence text included). Note: **DSH does not load skills from a plugin directory automatically** — copy them into `~/.dsh/skills/` before they show up in a session's skill catalog (a one-line copy command is in [`skills/README.md`](skills/README.md)). They are optional: the policy bodies are self-contained, and the skills are only a more detailed playbook.
- **[Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)** — the four elements of a delegation contract, the scale ladder by complexity, the "multi-agent burns roughly 15× tokens" cost fact, and children writing artifacts to files and returning only a pointer.
- **[Feather Icons](https://github.com/feathericons/feather)' `zap`** (MIT) — the SVG path of the Lightning switch.
- **[React](https://github.com/facebook/react)** (MIT) — peer dependency, taken from the host's module loader and not bundled.

This plugin has **zero runtime dependencies**, makes no network requests and carries no telemetry. Apart from those 4 skills (third-party source, bundled verbatim under `skills/`, and perfectly fine to skip), the repository contains no other third-party source code.
