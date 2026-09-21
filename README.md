# unreal-mcp

The most comprehensive MCP server for Unreal Engine — **127 tools** across **16 subsystems**, with **4 transport layers** and **no mandatory C++ plugin**.

> This is a security-hardened fork of [sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp). It fixes a command-injection vulnerability in the build/subprocess tools and documents how to lock down the network-facing transports before you enable them. See [Security](#security) before installing.

> **Beta** — This project is under active development and testing. Tools are being validated against UE 5.6. Some tools may not work as expected. Bug reports and contributions are welcome.

## Why This One?

| | unreal-mcp | [flopperam](https://github.com/flopperam/unreal-engine-mcp) | [chongdashu](https://github.com/chongdashu/unreal-mcp) | [kvick-games](https://github.com/kvick-games/UnrealMCP) | [ChiR24](https://github.com/ChiR24/Unreal_mcp) |
|---|---|---|---|---|---|
| Tools | **127** | ~30 | ~20 | ~5 | 36 |
| Transports | **4** | 1 | 1 | 1 | 1 |
| Requires C++ plugin | **No** | Yes | Yes | Yes | Yes |
| Build/package tools | **Yes** | No | No | No | Partial |

Most Unreal MCP projects require compiling and installing a custom C++ plugin into your UE project. This one works out of the box by using Unreal's built-in Python and Remote Control plugins — zero-install beyond enabling what already ships with UE.

## Security

Before enabling anything below, understand what you're turning on: `execute_python` and the build/subprocess tools are, by design, arbitrary code execution — that's the feature, not a bug. The two things worth being deliberate about are (1) not exposing that to your local network, and (2) keeping the server's own code free of injection bugs on top of that. This fork addresses both; the original repo does not.

**Command injection (fixed in this fork, commit `87a4f6e`).** `SubprocessRunner` (`src/transports/subprocess.ts`) used to spawn `RunUAT.bat`/`UnrealBuildTool.exe`/commandlets with `shell: true` and forwarded free-text tool parameters (`build_target`'s `platform`, `build_plugin`'s `output_path`, `resave_packages`'s `directory`, etc.) straight into argv with no validation. On Windows, `shell: true` routes the whole command line through `cmd.exe`, which treats `& | ^ < > ( ) ! " ' %` as operators regardless of array-based args — a malicious value in any of those parameters could run arbitrary OS commands. This is a *separate* code path from Python Remote Execution or the Remote Control API: it needs neither the editor running nor any plugin enabled, just an engine path. Fixed by dropping `shell: true` and adding `src/utils/safe-arg.ts`, a zod schema rejecting shell metacharacters on every parameter that reaches `SubprocessRunner`, applied as defense-in-depth independent of `spawn()`'s own behavior. Also bumped `engines.node` to `>=22.0.0`: removing `shell: true` alone is only sufficient on a Node version patched against [CVE-2024-27980](https://nvd.nist.gov/vuln/detail/CVE-2024-27980) (Node's own implicit `.bat` invocation had a related bug, fixed in 18.20.2/20.12.2/21.7.3+); 22.x sidesteps the whole affected range.

**Network exposure (your responsibility to configure, not something this fork can fix in code).** Both Python Remote Execution and the Remote Control API are UE Editor features — enabling them opens real, unauthenticated-by-default network listeners:

- The Remote Control HTTP API (port 30010) has **no bind-address setting at all** — the engine always binds `0.0.0.0`. The only gate is `AllowlistedClients`, and Epic's own default for that setting is `0.0.0.0–255.255.255.255`, i.e. "allow everyone." The confusingly-named `bRestrictServerAccess` checkbox isn't itself an access restriction — it's the master switch that activates the allowlist/passphrase checks at all; leaving it off means neither ever runs. See [`Config/RemoteControl.ini`](#remote-control-hardened-config) below for the actual fix, verified against the UE 5.5 engine source (`RemoteControlDefaultPreprocessors.h`, `RemoteControlSettings.h`).
- Python Remote Execution's Multicast Bind Address defaults to `127.0.0.1` (loopback-only). **Do not blindly set it to `0.0.0.0`** the way some UE 5.3+ troubleshooting threads suggest (see the Editor Setup section below for when that's actually warranted) — that opens the UDP discovery + inverted-TCP command channel to your whole LAN, and this server only ever talks to `127.0.0.1` anyway (`connection-manager.ts`), so it isn't needed for local use.

If you can reach a UE Editor's Remote Control API or Python Remote Execution ports from another machine on your network without a passphrase, that's a live remote-code-execution surface, independent of anything in this repo's own code — this server just gives you an ergonomic way to use those features, it doesn't introduce the exposure.

## Quick Start

### Prerequisites

- Node.js **>= 22.0.0** (see [Security](#security) for why)
- Unreal Engine 5.x with editor open
- **Python Editor Script Plugin** enabled (built-in) with **Enable Remote Execution** checked in its settings

### Install

```bash
git clone https://github.com/jjpxdev/unreal-mcp.git
cd unreal-mcp
npm install
```

`npm install` now builds `dist/` automatically via a `prepare` script — no separate `npm run build` needed (though `npm run build` still works if you want to rebuild after pulling changes without reinstalling).

> **Installing via `npx`/`github:` spec doesn't currently work.** `npx github:jjpxdev/unreal-mcp` (and the `git+https://` and `--package=` variants) fail with `GitFetcher requires an Arborist constructor to pack a tarball` on npm 10.9.8 — a known npm limitation with `npx` executing git specs directly, not something fixable from this repo. `npm install github:jjpxdev/unreal-mcp#<commit>` (as a project dependency, not via `npx`) works fine and does run `prepare` correctly — use that if you want to pull a specific pinned commit without a manual clone.

### Add to Claude Code

**Per-project, portable across a team** — commit a `.mcp.json` in your UE project root referencing an environment variable rather than a machine-specific path, so it works regardless of where each dev cloned this repo:

```json
{
  "mcpServers": {
    "unreal-mcp": {
      "command": "node",
      "args": ["${UNREAL_MCP_INSTALL_PATH}/dist/bin.js"]
    }
  }
}
```

Each dev sets `UNREAL_MCP_INSTALL_PATH` once (in their shell profile / user environment variables) to point at their local clone of this repo. Claude Code expands `${VAR}` in `.mcp.json` at startup from the shell environment.

**Per-project, single machine** (simpler if you're not sharing the config):
```bash
claude mcp add --transport stdio unreal-mcp -- node /path/to/unreal-mcp/dist/bin.js
```

**Global** (available in all projects):
```bash
claude mcp add --scope user --transport stdio unreal-mcp -- node /path/to/unreal-mcp/dist/bin.js
```

Then, optionally, drop a `.unrealmcp.json` in each UE project — as of this fork, `enginePath` is genuinely optional (see next section), so this is often all you need:
```json
{
  "projectPath": "."
}
```

### Add to Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "unreal": {
      "command": "node",
      "args": ["/path/to/unreal-mcp/dist/bin.js"],
      "env": {
        "UNREAL_MCP_PROJECT_PATH": "/path/to/YourProject.uproject"
      }
    }
  }
}
```

### Set up automatically with Claude Code

Rather than following the manual steps below by hand, you can point Claude Code at this README and your UE project and have it do the setup for you — clone/install this repo, enable the right plugins in your `.uproject`, write the hardened `RemoteControl.ini`/`DefaultEngine.ini` config, set the environment variable, and smoke-test that the server actually resolves your project and engine paths correctly before you rely on it. A prompt along these lines works well:

> Read the unreal-mcp README at https://github.com/jjpxdev/unreal-mcp and set it up for this project: clone/install the repo, enable whatever UE plugins and ini settings are actually needed (following the Security section's hardened config, not the unhardened defaults), register it with Claude Code, and verify the server starts and correctly detects this project's engine path before telling me it's done.

Worth asking it to actually run the server once (e.g. `node dist/bin.js --project-path <your project>` for a few seconds) and check the `[unreal-mcp] Engine: ...` line in its stderr output rather than just trusting that config files look right — that's the only way to confirm the project/engine path resolution and any plugin/ini changes actually took effect end-to-end.

## Tool Modules

| Module | Tools | Description |
|--------|-------|-------------|
| **actor** | 10 | Spawn, delete, transform, select, duplicate, tag actors |
| **asset** | 16 | List, search, import, export, rename, delete, validate assets |
| **blueprint** | 12 | Create blueprints, add components/variables/functions, graph nodes |
| **build** | 9 | Build targets, cook content, package, generate project files |
| **material** | 13 | Create materials/instances, add expressions, wire graphs |
| **console** | 6 | Execute Python, console commands, screenshots, viewport camera |
| **sequencer** | 8 | Create sequences, add tracks/bindings, set playback range |
| **animation** | 6 | Animation blueprints, montages, modifiers, skeletal mesh |
| **niagara** | 8 | Spawn particle systems, set parameters (float/vector/color/bool) |
| **editor-utils** | 8 | Undo/redo, LOD generation, collision, lightmap UVs, utility widgets |
| **testing** | 8 | Automation tests, map check, data validation, Gauntlet |
| **profiling** | 5 | CSV profiling, Unreal Insights traces, stat commands |
| **source-control** | 6 | Status, checkout, checkin, revert, mark for add, diff |
| **world-partition** | 4 | Data layers, streaming sources, loaded cells |
| **remote-control-presets** | 5 | List/get/set preset properties, call preset functions |
| **plugin** | 3 | List, enable, disable plugins in .uproject |

## Architecture

```
MCP Client (Claude Code, Claude Desktop, etc.)
  ↕ stdio (MCP protocol)
unreal-mcp server
  ↕ 4 transport layers
Unreal Engine
```

### Transport Layers

| Transport | Protocol | Port | What It Needs |
|-----------|----------|------|---------------|
| **Python Remote Execution** | UDP multicast + inverted TCP | 6776 | Python Editor Script Plugin (built-in) |
| **Remote Control API** | HTTP REST | 30010 | Remote Control API plugin (built-in) — see [Security](#security) before enabling |
| **Plugin Bridge** | TCP, length-prefixed JSON | 55557 | Optional C++ plugin |
| **Subprocess Runner** | Spawns UAT/UBT processes | N/A | Engine path only — works with the editor closed |

The server probes all transports on startup and tools gracefully degrade. Most tools use Python Remote Execution. Build tools use subprocess (no plugin/editor required at all). The optional C++ plugin adds deep Blueprint graph manipulation.

### Two Paths

- **Minimal path**: Python Remote Execution alone covers the large majority of tools (everything except `remote-control-presets` and the RC-fallback for Python execution). Smaller network-facing surface — no Remote Control API listener at all.
- **Core path** (no C++ plugin): Python + Remote Control together cover ~95% of tools, including `remote-control-presets`. Remote Control also serves as a fallback Python-execution path if the primary transport is unavailable.
- **Plugin path** (optional): C++ plugin on port 55557 adds K2 node graph manipulation, faster bulk operations, and editor UI integration. Falls back to Python automatically when unavailable. **Note:** the `plugin/UnrealMCPBridge/` C++ plugin referenced by this doc is not currently present in this repo — Blueprint graph tools (`add_graph_node`, `connect_graph_nodes`, `remove_graph_node`) are not functional out of the box.

## Configuration

Three-layer priority: CLI args > environment variables > config file > defaults.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNREAL_MCP_PROJECT_PATH` | — | Path to .uproject file or project directory |
| `UNREAL_MCP_ENGINE_PATH` | auto-detect | UE engine install path — see auto-detection note below |
| `UNREAL_MCP_RC_PORT` | 30010 | Remote Control API port |
| `UNREAL_MCP_PYTHON_PORT` | 6776 | Python Remote Execution port |
| `UNREAL_MCP_PLATFORM` | Win64 | Target platform |
| `UNREAL_MCP_CONFIGURATION` | Development | Build configuration |
| `UNREAL_MCP_MODULES` | all | Comma-separated list of modules to enable |

**Engine path auto-detection (fixed in this fork, commit `3e1cc98`)**: the original code's `.uproject` lookup called `require("node:fs")` inside this package's ESM build (`"type": "module"`) — `require` isn't defined in ESM scope, so it silently threw and was caught, meaning auto-detection *never actually found a `.uproject` file* unless `projectPath` was passed as a literal `.uproject` path. Fixed to use the already-imported `readdirSync`. Also added a Windows registry lookup ahead of the hardcoded `Program Files` candidates: a plain-version `EngineAssociation` (e.g. `"5.5"`) resolves via `HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>\InstalledDirectory`, and a GUID association via `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds\<GUID>` — covers custom/non-default install locations (different drive, source builds) the hardcoded candidates can't guess. In practice this means most projects no longer need `enginePath` set explicitly at all.

### CLI Arguments

```bash
node dist/bin.js --project-path /path/to/project --engine-path /path/to/UE_5.5 --rc-port 30010
```

### Config File

Place `.unrealmcp.json` in your project directory or home directory. With engine auto-detection now working, this is often all you need:

```json
{
  "projectPath": ".",
  "platform": "Win64",
  "configuration": "Development"
}
```

`enginePath` and `enabledModules` remain available if you need to override auto-detection or trim the tool surface:

```json
{
  "projectPath": ".",
  "enginePath": "D:/CustomEngineLocation/UE_5.5",
  "enabledModules": ["console", "actor", "asset", "build", "blueprint", "material"]
}
```

## Unreal Editor Setup

### Required (for most tools)

1. Edit > Plugins > enable **Python Editor Script Plugin**
2. Restart the editor
3. Edit > Project Settings > Plugins > **Python** > scroll to **Remote Execution** section:
   - Check **Enable Remote Execution** (`bRemoteExecution=True`)
   - Leave **Multicast Bind Address** at its default `127.0.0.1`. This server only ever connects to `127.0.0.1`, so loopback is sufficient for local use — don't widen it to `0.0.0.0` preemptively.
   - Verify Multicast Group Endpoint is `239.0.0.1:6766` (the default)
4. Restart the editor again

**Only if discovery genuinely fails** ("No Unreal Editor nodes found" *after* confirming the editor is running with Remote Execution enabled, not just before installing this server) — UE 5.3+ has a known issue where certain adapters break multicast even for local clients:
- **VPN/Tailscale users:** Tailscale's virtual network adapter can hijack multicast. Try temporarily disabling Tailscale, or disable the Tailscale network adapter in Windows Network Connections, before resorting to widening the bind address.
- **Multiple adapters:** WSL, Hyper-V, and VPN adapters can all cause multicast to bind to the wrong interface. Disabling unused adapters helps.
- **Last resort:** if none of the above resolves it, widening Multicast Bind Address to `0.0.0.0` is a real fix for this specific problem — but it opens the UDP/TCP channel to your LAN, so prefer firewalling UDP 6766 / TCP 6776 to trusted hosts over leaving it fully open.
- **Firewall:** allow UDP port 6766 and TCP port 6776 between the editor and this server's host (same machine, so usually not needed) rather than disabling Windows Firewall entirely.

### Optional (for Remote Control tools)

Only enable this if you need `remote-control-presets` or want a fallback Python-execution path — Python Remote Execution above already covers the large majority of tools on its own. If you enable it, harden it; the defaults are not safe to leave as-is (see [Security](#security)).

1. Edit > Plugins > enable **Remote Control API**
2. Restart the editor
3. Edit > Project Settings > Plugins > **Remote Control** > **Server**:
   - Check **Restrict Server Access** (`bRestrictServerAccess=True`) — despite the name, this *enables* the security checks below rather than restricting anything by itself; leaving it unchecked means neither the IP allowlist nor passphrase enforcement ever runs, for anyone, from anywhere reachable.
   - Check **Enable Remote Python Execution** and **Allow Console Command Remote Execution** — required for this server's RC-based tools to function; access is gated by the allowlist below, not by leaving these off.
   - **Narrow "Range of Allowlisted Clients" from the default (`0.0.0.0`–`255.255.255.255`, i.e. everyone) to `127.0.0.1`–`127.0.0.1`.** This is the actual access gate for the HTTP API (port 30010), which has no separate bind-address setting.
   - Bind Address fields for the **Remote Control Web Interface** (port 30000) and **Remote Control Websocket Bind Address** (port 30020) — set both to `127.0.0.1` if you don't need LAN access to those.
   - These take effect immediately, no restart needed.

<a id="remote-control-hardened-config"></a>Equivalent `Config/RemoteControl.ini` (drop in your UE project's `Config/` directory instead of clicking through the panel), verified against the UE 5.5 engine source:

```ini
[/Script/RemoteControlCommon.RemoteControlSettings]
bRestrictServerAccess=True
RemoteControlWebInterfaceBindAddress=127.0.0.1
RemoteControlWebsocketServerBindAddress=127.0.0.1
bEnableRemotePythonExecution=True
bAllowConsoleCommandRemoteExecution=True
bEnforcePassphraseForRemoteClients=True
!AllowlistedClients=ClearArray
+AllowlistedClients=(LowerBound=(ClassA=127,ClassB=0,ClassC=0,ClassD=1),UpperBound=(ClassA=127,ClassB=0,ClassC=0,ClassD=1))
```

The `!AllowlistedClients=ClearArray` line matters: the wide-open default is a C++ class default (`FRCNetworkAddressRange::AllowAllIPs()`), not just an inherited ini value — without explicitly clearing it, a narrower range you add just sits *alongside* the wide-open one rather than replacing it.

### Optional (for Blueprint graph tools)

Install the C++ plugin from `plugin/UnrealMCPBridge/` into your project's `Plugins/` directory. **Not currently included in this repo** — this folder doesn't exist yet, so `add_graph_node`/`connect_graph_nodes`/`remove_graph_node` won't work until it's added.

## Development

```bash
npm run dev        # Watch-mode dev server
npm run build      # Compile TypeScript
npm run lint       # Biome linter
npm run fmt        # Biome formatter
npm test           # Run tests
```

## License

MIT
