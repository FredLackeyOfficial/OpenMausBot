# Container worker qualification coverage

Recorded 2026-11-14 against the integration worktree. This is bounded verification evidence, not a promise that every provider account, native tool, client release or deployment platform works. No live credentials or user client homes were used. Fixture containers were removed; images and evidence were retained locally.

## Current result

All **29 registered drivers** completed streamed turns through their actual production driver inside Docker using synthetic clients or loopback HTTP providers. The matrix passed **31/31 tests**, including exhaustive registry membership, Antigravity filesystem callbacks, and Cline's private generated configuration. The same matrix passed in source subprocess mode. Seven installed native clients additionally executed real shell tools against synthetic inference endpoints. Eighteen of the 19 named native clients installed and reported versions; Hermes installation exceeded its bounded deadline. Custom ACP also initialized real Mistral Vibe.

The production Docker isolation/Stop test passed **1/1**, and the real coordinator HTTP/delegation test passed **1/1**, on the final runtime. The subsequent reproducible smoke rerun also passed both tests (2/2) and the matrix (31/31); its CI-tagged image IDs and JSON results are recorded below. These are separate checks from the 31-test matrix.

## Per-driver matrix

**Docker** means a complete synthetic-protocol turn through the real driver and production supervisor. **Native** distinguishes startup/initialize from actual installed-client tool execution. **Worker package** means the built worker runtime executes without a source checkout or host node_modules mount; it does not mean a complete desktop installer was exercised per adapter. **Live** is current live-account/provider testing. **Linux host** excludes Docker Desktop's Linux VM. “Not run” and “Blocked” are not passes.

| Driver ID | Actual protocol | Docker synthetic | Native client in Docker | Live | Linux host | Worker package |
| --- | --- | --- | --- | --- | --- | --- |
| `claudeAgent` | Streaming JSON | Pass | 2.1.325; tool turn | Not run | Not run | Pass |
| `codex` | App-server JSON-RPC | Pass | 0.169.0; tool turn | Not run | Not run | Pass |
| `piAgent` | pi RPC | Pass | 1.5.2; tool turn | Not run | Not run | Pass |
| `museCode` | Muse Session Protocol | Pass | 1.4.20; initialize | Not run | Not run | Pass |
| `grokAgent` | ACP stdio | Pass | 1.0.77; initialize | Not run | Not run | Pass |
| `geminiAgent` | ACP stdio | Pass | 0.68.0; tool turn | Not run | Not run | Pass |
| `kimiAgent` | ACP stdio | Pass | 2.6.2; initialize | Not run | Not run | Pass |
| `droidAgent` | ACP stdio | Pass | 1.12.1; initialize | Not run | Not run | Pass |
| `cursorAgent` | ACP stdio | Pass | 2026.11.13-eacade1; initialize | Not run | Not run | Pass |
| `opencodeGo` | ACP stdio | Pass | 2.3.0; tool turn | Not run | Not run | Pass |
| `qwenAgent` | ACP stdio | Pass | 0.27.3; initialize | Not run | Not run | Pass |
| `hermesAgent` | ACP stdio | Pass | Blocked: install timeout | Not run | Not run | Pass |
| `clineAgent` | ACP stdio | Pass | 3.0.74; tool turn | Not run | Not run | Pass |
| `copilotAgent` | ACP stdio | Pass | 1.0.112; initialize | Not run | Not run | Pass |
| `commandCodeAgent` | ACP stdio | Pass | 1.89.1; initialize | Not run | Not run | Pass |
| `kiroAgent` | ACP stdio | Pass | 3.3.0; initialize, signed out | Not run | Not run | Pass |
| `ompAgent` | ACP stdio | Pass | 18.20.0; tool turn | Not run | Not run | Pass |
| `deepseekAgent` | ACP stdio | Pass | 0.2.2-rc.1; initialize | Not run | Not run | Pass |
| `antigravityAgent` | Managed ACP + filesystem callbacks | Pass | 1.4.3; initialize | Not run | Not run | Pass |
| `customAcp` | Configured ACP stdio | Pass | Vibe 3.1.2; initialize | Not run | Not run | Pass |
| `grok` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `openai-compat` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `minimax` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `mistral` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `cerebras` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `groq` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `greenference` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `modelgo` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |
| `meta` | HTTP Chat Completions + tool loop | Pass | N/A: no native CLI | Not run | Not run | Pass |

## What the passing checks establish

- `server/container-workers/provider-matrix.test.ts`: all 29 real registry drivers execute inside the worker. The 20 executable rows use protocol fixtures; the nine HTTP rows use a local Chat Completions server and execute the actual worker-local MCP coordination tool. The parent coordination capability remains outside the worker. Antigravity callbacks allow a workspace read and refuse an outside read. Cline's generated settings are inside worker temp with mode 0600. The final Claude turn exercises the private IPC path.
- `server/container-workers/docker.test.ts`: two simultaneous workers; nonroot UID, read-only root, capability drop, no-new-privileges, network none, memory/CPU/PID limits, exact home/temp/workspace binds and private IPC tmpfs verified through Docker inspect. Synthetic inherited secret is absent; sibling/coordinator/socket/source reads and root writes fail, while intended writes succeed. Duplicate launch preserves its owner. Stop removes the entire worker, a next turn creates a fresh generation, and the sibling survives. Forced supervisor death stops detached descendants; persistent state survives recreation. One supervisor is copied outside the source tree and run as a standalone bundled artifact.
- `server/container-workers/http.e2e.test.ts`: isolated real coordinator, direct operator turn, actual Chief-to-specialist delegation through worker RPC, recipient workspace selection, and 48 denied admin HTTP probes, including bare requests and spoofed headers. The coordinator in this fixture runs from source; the workers run from the packaged image.
- `server/container-workers/launcher.test.ts` and independent delayed-creation reproduction: Stop during `docker create` waits for the result, removes the exact owned immutable ID, and never starts the worker. Uncertain creation/cleanup returns exit 70 and blocks generation reuse. Broken stdout/stderr pipes enter normal cleanup; an unexpected supervisor exception or exit reports 70 unless cleanup was explicitly confirmed. Fault-injection tests cover the output-pipe failure, failed removal, and unexpected exception. Foreign labels are preserved. Linux temp tests cover root ownership assignment and nonroot mismatch refusal; a separate isolated Linux-container check confirmed 0700 ownership and writes.

The private `/run/omb` IPC tmpfs is non-executable, size-limited and owned by the worker. It resolves Docker Desktop's Unix-socket chmod limitation without weakening socket permissions. General temporary files still use the configured `/tmp` bind.

## Installed-client evidence and limits

Seven real clients—Claude, Codex, Pi, OpenCode, Cline, OMP and Gemini—ran their actual advertised shell tools. Each produced an independently checked workspace marker and attempted three forbidden reads: an unmounted host canary, an unmounted sibling canary, and the Docker socket. All **21 read attempts failed** and the host canaries were unchanged. Synthetic provider replies supplied tool calls; this is no claim about live model planning or account authentication.

Explicit native approval requests were denied and produced no execution marker for Claude, Cline, OMP, Gemini and Codex's explicit escalation case. Pi and OpenCode's native Ask settings emitted no approval request and allowed the disposable workspace command; no denial was exercised for them. Approval mode remains provider-native. Codex's ordinary Ask execution hit its nested bubblewrap user-namespace restriction under the chosen hardened container flags; that failure is not counted as approval evidence. Its Full execution and explicit escalation-denial paths passed.

The native tool fixture invokes the built production worker directly with explicit Docker flags and a loopback provider. It does **not** invoke the host production facade/policy/supervisor. Its `/tmp` is executable tmpfs and its PID limit is 256, whereas production uses a temp bind and PID limit 128. Therefore the native evidence supplements, rather than replaces, the final production-supervisor matrix and Stop checks. Native tool results use the earlier pinned native v2 image below, not the final v3 supervisor/IPC image.

Other native rows reached their protocol initialization only; this proves neither a session nor a tool turn. Muse's corrected initialization includes the required clientInfo; the earlier invalidParams probe is superseded, but its read-only self-update-stamp warning remains. Kiro explicitly reports signed-out state. Antigravity's startup fixture terminates the client after its valid initialize reply; its shutdown diagnostic is not treated as a completed turn. Hermes' official stable v0.23.1 installer exceeded 120 seconds during its repository checkout; no Hermes binary or real-client turn is claimed. Live turns for all rows require deliberately selected scoped credentials; existing host logins were not inspected or reused.

## Exact local images and platform

These are locally inspected image IDs, not pullable registry digests. No image was published.

| Artifact | Tag used | Inspected image ID |
| --- | --- | --- |
| Prior v3 production runtime (Stop 1/1) | `omb-container-runtime:qualification-v3` | `sha256:1ede0b20be2aef463aec02752ae70af0da0076a6ff648497e4fcad07c60fa819` |
| Prior v3 matrix wrapper (31/31) | `omb-container-runtime:matrix-v3` | `sha256:0ce277d6f4a84904d0d54b146d5839f0646ac0decf8227d2bbf6a93e1472487c` |
| Latest production smoke (2/2) | `omb-container-runtime:ci` | `sha256:829fe0245b8ea77691001ed5a780f9b6d522e6fe3e674bf11a83e94c5c51b6bc` |
| Latest synthetic matrix smoke (31/31) | `omb-container-runtime:matrix-ci` | `sha256:8fd427a9cb3878a0931274da0950ae2f48b5e42b6162104ae73d22f7c6be322f` |
| Native seven-client tool worker | `omb-container-native:qualification-v2` | `sha256:be000d819ee812428aa3585f8315aeac84e1e9803f943b4d3d82c228a6e4ff69` |
| Extra official native clients + Vibe | `omb-container-extra-native:qualification` | `sha256:fcc6d8068723e49c27a7d976346638ce4cb2c03a687cc80b02fb1c749e25e36b` |

Host: macOS, Docker Desktop 4.97.0, Docker client/server 29.9.2; daemon Linux arm64/aarch64. Repository Node 26.13.0 and pnpm 10.33.0. The final runtime copies the complete `dist-server` bundle into the image. It does not ship every vendor CLI: deployments must build their selected clients into a derived image. Standalone Linux/VPS, Linux amd64, and full desktop installation coverage remain unqualified here.

## Reproduction and evidence provenance

Run from the repository with its pinned Node/pnpm, a reachable Docker daemon, and no live credentials:

```sh
pnpm build:server
OMB_DOCKER=/absolute/path/to/docker node scripts/smoke-container-workers.mjs
```

The smoke script builds fresh production and matrix images and runs the isolation/Stop test, HTTP coordinator test, and all-driver matrix. `OMB_DOCKER_CONFIG` optionally selects an owned Docker CLI configuration. Source-only protocol coverage is:

```sh
pnpm exec vitest run server/container-workers/provider-matrix.test.ts
pnpm exec vitest run server/container-workers/launcher.test.ts server/container-workers/temp.test.ts
```

Docker JSON evidence is written under `.omb-scratch/verify-evidence/container-workers/`: `docker-provider-isolation.json` and `http-coordinator.json`. The latest retained records correspond to the CI-tagged images after the broken-pipe/exit-guard fix, superseding earlier v3 and earlier CI records at those paths. `docker-smoke-vitest.json` records 2/2 passing tests; `docker-matrix-vitest.json` records 31/31. Keep the matrix test output alongside these artifacts and record the source commit, dirty-worktree status and inspected image IDs for each new run. The original qualification ran before the final integration commit; its image IDs, source tests and retained task logs identify that snapshot. Rebuilding does not preserve those image IDs automatically.

Native installation/tool evidence is retained in the task's local qualification bundle rather than checked into the product repository. Relative artifact names are `native-qualification/npm-release-metadata.json`, `npm-install-results.jsonl`, `startup-probes-exec.jsonl`, `extra-install-results.json`, `extra-startup-probes.jsonl`, `muse-startup-probe.jsonl`, and `native-tools/README.md`, `SUMMARY.json`, `v2-results.jsonl`. The native bundle includes pinned installation recipes, fetched installer hashes, fake-provider scripts, and `native-tools/run.sh`; its Codex explicit escalation evidence is separately identified in SUMMARY.json. These developer qualification results are not executed by the repository smoke script and should be rerun on a selected release before extending the support claim.

## Historical evidence

An earlier Codex-only prototype at source `d82b3c0ae6f400be3299a7607e32b2a9bcbb8039` completed a live Codex 0.169.0 / gpt-6.1-sol test, including containment, delegation, restart, Stop and denied approval. That retained proof predates the generic worker implementation and does not count as current live-provider coverage. It also ran on Docker Desktop, not a standalone Linux VPS. No current credential availability is inferred from that record.
