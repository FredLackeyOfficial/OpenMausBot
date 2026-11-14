# Container worker verification coverage

This matrix describes checks maintained in the repository. Synthetic clients and loopback providers exercise real adapters without live credentials. They do not qualify vendor binaries, authenticated accounts or production deployments. Record actual results, skips, source revision, platform and image IDs with each run; an entry in this matrix is not a recorded pass.

## Adapter contracts

`server/container-workers/provider-matrix.test.ts` checks exhaustive membership against the built-in driver registry and exercises each adapter in the worker. It runs in subprocess mode by default; the Docker smoke command runs it through the production supervisor using the packaged worker and a fixture image.

| Driver ID | Protocol | Automated coverage |
| --- | --- | --- |
| `claudeAgent` | Streaming JSON | Synthetic turn |
| `codex` | App-server JSON-RPC | Synthetic turn |
| `piAgent` | pi RPC | Synthetic turn |
| `museCode` | Muse Session Protocol | Synthetic turn |
| `grokAgent` | ACP stdio | Synthetic turn |
| `geminiAgent` | ACP stdio | Synthetic turn |
| `kimiAgent` | ACP stdio | Synthetic turn |
| `droidAgent` | ACP stdio | Synthetic turn |
| `cursorAgent` | ACP stdio | Synthetic turn |
| `opencodeGo` | ACP stdio | Synthetic turn |
| `qwenAgent` | ACP stdio | Synthetic turn |
| `hermesAgent` | ACP stdio | Synthetic turn |
| `clineAgent` | ACP stdio | Synthetic turn |
| `copilotAgent` | ACP stdio | Synthetic turn |
| `commandCodeAgent` | ACP stdio | Synthetic turn |
| `kiroAgent` | ACP stdio | Synthetic turn |
| `ompAgent` | ACP stdio | Synthetic turn |
| `deepseekAgent` | ACP stdio | Synthetic turn |
| `antigravityAgent` | Managed ACP + filesystem callbacks | Synthetic turn |
| `customAcp` | Configured ACP stdio | Synthetic turn |
| `grok` | HTTP Chat Completions + tool loop | Synthetic turn |
| `openai-compat` | HTTP Chat Completions + tool loop | Synthetic turn |
| `minimax` | HTTP Chat Completions + tool loop | Synthetic turn |
| `mistral` | HTTP Chat Completions + tool loop | Synthetic turn |
| `cerebras` | HTTP Chat Completions + tool loop | Synthetic turn |
| `groq` | HTTP Chat Completions + tool loop | Synthetic turn |
| `greenference` | HTTP Chat Completions + tool loop | Synthetic turn |
| `modelgo` | HTTP Chat Completions + tool loop | Synthetic turn |
| `meta` | HTTP Chat Completions + tool loop | Synthetic turn |

The executable adapters use synthetic protocol clients. All nine API adapters use loopback HTTP responses and execute the worker-local coordination tool. Additional cases exercise Antigravity filesystem callbacks inside and outside the permitted workspace and Cline's private generated settings. The Claude case exercises the private IPC path.

## Boundary and lifecycle checks

- `server/container-workers/policy.test.ts` and `server/container-workers/boundary.test.ts` cover disjoint mounts, administrative-directory exclusion, reserved paths, explicit environment, bot assignments and refusal of host fallback.
- `server/container-workers/protocol-boundary.test.ts` and `server/container-workers/provider-worker.test.ts` cover RPC validation, coordinator-owned identities, restricted coordination, approval routing and worker-local execution.
- `server/container-workers/launcher.test.ts` and `server/container-workers/temp.test.ts` cover cancellation during container creation, immutable container ownership, failed cleanup, broken output pipes, unexpected supervisor exit and temporary-directory ownership.
- `server/container-workers/docker.test.ts` inspects actual container mounts and hardening, tests two workers' filesystem isolation, confirms persistent state and verifies Stop, recreation and detached-process cleanup. It also runs a copied supervisor outside the source tree.
- `server/container-workers/http.e2e.test.ts` runs an isolated real coordinator with packaged workers. It tests authenticated turns, unauthorized HTTP access, recipient-workspace delegation and refusal of cross-bot shared-folder delegation.

The Docker fixtures use synthetic executables and disposable data. Native tools, provider accounts and host integrations outside those fixtures are not covered by these checks.

## Reproduction

Run source checks from the repository root:

```sh
pnpm exec vitest run server/container-workers server/harness/registry.test.ts
```

Docker cases are skipped unless explicitly enabled. To build fresh runtime and matrix images and execute the Docker checks:

```sh
pnpm build:server
OMB_DOCKER=/absolute/path/to/docker node scripts/smoke-container-workers.mjs
```

`OMB_DOCKER_CONFIG` optionally selects an owned Docker CLI configuration. The smoke command writes `docker-provider-isolation.json`, `http-coordinator.json`, `docker-smoke-vitest.json` and `docker-matrix-vitest.json` under the ignored `.omb-scratch/verify-evidence/container-workers/` directory. Keep those run-specific artifacts outside source commits. Record the exact source revision and whether the checkout was modified, inspected image IDs, platform, command results and skipped cases alongside them.

## Qualification beyond these tests

Deployment qualification must separately exercise the selected installed client versions and deliberately provisioned accounts under the production supervisor and container settings. Initialization alone is not a completed turn. A tool result must establish that the installed client executed the tool; an approval-denial result requires an actual emitted approval request. Approval semantics remain native to each client.

Test the target host platform and architecture explicitly. Docker Desktop's Linux VM does not establish standalone Linux VPS qualification. Tests using different mounts, process limits or launch paths do not qualify production settings. Missing credentials, unavailable binaries and unsupported clients remain explicit gaps. A dedicated Docker network is not an egress firewall.

See [the worker configuration and verification recipe](container-workers.md) for supported coordinator platforms, image provisioning and excluded integrations.
