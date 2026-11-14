# Native Codex in isolated Docker workers

This prototype keeps one OpenMausBot server for conversations and coordination and runs each bot's native Codex CLI in a dedicated Docker execution container. It uses Codex's existing `app-server` protocol, not ACP. The trusted server and launcher retain Docker authority; workers receive neither the Docker socket nor the server's coordination credentials.

The operator supplies `container-workers.json` in the server's data directory. Its presence enables a closed policy: every engine must have a worker assignment, every turn must identify the assigned bot, and its working directory must be within that bot's declared mounts. Unknown engines and wrong-bot selections fail before an engine starts. Engine settings in the UI cannot override the policy's launcher. Restart after changing this policy.

Container mode also requires authenticated clients, including on loopback. A worker can appear to the server as a local caller on Docker Desktop. The ordinary local-service exceptions for reading chats, posting work and declining approvals are therefore disabled; only health and separately authenticated internal capability routes remain available without a paired session. Pair your operator client before enabling this policy, or start through `openmausbot serve` with `OMB_LOOPBACK_TRUST=service` and use its authenticated pairing flow. Run the standalone server: the embedded desktop-server mode is refused.

## Build and configure

From a source checkout with Node 26 and dependencies installed:

```sh
docker build -t omb-container-codex:0.169.0 server/container-workers
```

The image installs native Codex CLI 0.169.0, Git and system TLS certificates. Resolve the resulting image ID with `docker image inspect` and use that immutable ID in the policy. Build on the intended CPU architecture.

Create separate home, temporary, bot-workspace and conversation-workspace directories for every bot. Their host paths must be canonical absolute directories, with no overlap, and writable by the configured non-root UID/GID. Authenticate Codex separately in each bot's home, or provision an explicitly selected credential there. Do not mount your entire personal home or OpenMausBot data directory.

Example policy for one existing bot (repeat with different directories, bot ID, instance ID and network for another):

```json
{
  "docker": "/usr/bin/docker",
  "workers": {
    "ACTUAL-BOT-ID": {
      "instanceId": "codex-project-a",
      "image": "sha256:ACTUAL-IMAGE-ID",
      "command": ["codex"],
      "home": "/srv/omb-workers/project-a/home",
      "temp": "/srv/omb-workers/project-a/tmp",
      "workspaces": [
        "/srv/openmausbot/workspaces/ACTUAL-BOT-ID",
        "/srv/openmausbot/task-workspaces/ACTUAL-BOT-ID"
      ],
      "network": "omb-project-a",
      "user": "1000:1000"
    }
  }
}
```

Create each named network with `docker network create NAME`. `none` is the default and supports offline engines; live Codex needs network access. Shared default/host networks and reusing a named network across workers are refused. Dedicated networks separate Docker peers; this is not a general Internet/LAN egress firewall. Protect other host/LAN services independently. Keep the coordinator private and require authenticated access for remote clients.

In the ordinary OpenMausBot `config.json`, register the matching engine:

```json
{
  "instances": {
    "codex-project-a": { "driver": "codex", "displayName": "Project A container", "config": {} }
  }
}
```

Select that instance for the corresponding bot. The server enforces the binding when a turn starts, including a fallback dispatch; the UI may still let an operator save an invalid selection, but it cannot execute it. A newly created bot needs an explicit policy assignment before it can run. Existing unrelated VPS workers need no changes.

Optional top-level `dockerConfig` and `context` select the operator's Docker configuration and context. Docker bind source paths must exist on the Docker host; the tested design colocates server and Docker, including Docker Desktop's host-file sharing. This is not an SSH path-transfer implementation.

## Boundaries and current limitations

- Home maps to `/home/agent`, temporary files to `/tmp`, and workspace paths retain their host absolute paths. Roots are read-only except those explicit mounts. Containers run non-root with dropped capabilities, no privilege escalation, and CPU, memory and process limits.
- One bot has at most one active `app-server` container. Concurrent execution attempts for that bot fail safely; this prototype does not yet queue multiple simultaneous conversations. Version/login/model probes use separate short-lived containers with that bot's mounts. Every execution container is removed when its launcher exits; files persist in the mounted directories.
- Coordination crosses a framed stdio connection and a worker-local socket. The host permits only `coordinate_bots` and `assignment_status`, retaining the existing turn token and selected tool restrictions. Model-generated requests cannot choose a Docker container or executable. No general shell/file tool runs on the coordinator through this bridge.
- The shared server remains trusted with conversations and shared results. Isolation between worker filesystems does not make conversations secret from the server.
- Other application tools, host browser/desktop integration and custom MCP servers are disabled for these workers. Native shell/files are supported. Attachments outside the declared mounts have not been integrated or qualified. Native tool-selection restrictions are refused rather than silently weakened.
- Background title/memory/permission-review APIs are disabled because their interface lacks a bot identity. Model discovery stays contained. Automatic memory upkeep requires further work.
- The operator must leave OpenMausBot's separate `OMB_BOT_BOX` process sandbox off for this prototype; it has not been integrated with the Docker-authorized launcher. The launcher is trusted host code and never runs inside a worker.
- This is a source-checkout prototype. Packaged desktop distribution, Linux VPS deployment, resource sizing under load and a hostile-protocol security audit remain unqualified.

## Reproducible proof

Policy and registry regression tests:

```sh
pnpm exec vitest run server/container-workers/policy.test.ts server/harness/registry.test.ts
```

Real Docker isolation and descendant-cleanup checks, without an AI account:

```sh
OMB_DOCKER_TEST=1 OMB_DOCKER=/usr/bin/docker pnpm exec vitest run server/container-workers/docker.test.ts
```

On Docker Desktop, set `OMB_DOCKER` to the Docker executable and, when needed, `OMB_DOCKER_CONFIG` to its configuration directory. The tests create their own containers and mounted directories, verify a normal stop and a forcibly killed launcher, and remove their fixtures. Their evidence is written under `.omb-scratch/verify-evidence/container-workers/`.

Live Codex proof through an isolated real OpenMausBot server:

```sh
OMB_CONTAINER_AUTH_FILE=/explicitly/selected/auth.json \
OMB_DOCKER=/usr/bin/docker \
node --experimental-strip-types scripts/verify-container-workers.ts
```

This deliberately uses the selected account and incurs model usage. It copies only the selected credential into two disposable homes; cleanup removes those copies, containers, networks and server data. The original credential and running applications are untouched. Optional `OMB_CONTAINER_MODEL` changes the default `gpt-6.1-sol` test model.

The runner prints its retained, credential-free evidence file and server log. It checks native shell execution, forbidden filesystem paths, Chief-to-specialist delegation, restart/file persistence, Stop with a detached descendant, and a denied native approval. Synthetic Docker checks establish the boundary independently of a model's narration. A passing local proof is not a claim that the integration is deployed or qualified on your VPS.
