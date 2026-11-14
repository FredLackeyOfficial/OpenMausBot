# Per-bot container workers

An optional `container-workers.json` in the coordinator's data directory assigns each engine instance to exactly one bot and Docker image. The complete engine adapter runs inside that bot's container: client creation, model probes, native protocols, ACP filesystem callbacks, API-backed tool loops, and helper processes. The coordinator retains conversations, user authentication, approval routing and Docker authority.

Synthetic protocol coverage is distinct from qualification of installed clients and authenticated accounts. The [coverage matrix](container-workers-coverage.md) describes the reproducible checks and their limits; a missing binary or credential is not a passing test.

## Build and configuration

Build the runtime, then its base image from the repository root:

```sh
pnpm build:server
docker build -f server/container-workers/Dockerfile -t omb-container-runtime:dev .
```

The image copies the self-contained `dist-server` tree. It does not bind-mount the coordinator's checkout or `node_modules`. Build derived images containing the Linux clients required by each bot. API-backed engines need no agent CLI. Use pinned client versions and record the resulting image digest when qualifying a deployment.

Create distinct, existing, canonical directories for each bot's home, temporary files and workspaces. The non-root container UID/GID must be able to write them on the Docker host. Keep coordinator data separate from these directories. An example policy is:

```json
{
  "docker": "/usr/bin/docker",
  "workers": {
    "project-a-bot": {
      "instanceId": "project-a-engine",
      "image": "your-codex-worker:tested-version",
      "home": "/srv/bots/project-a/home",
      "temp": "/srv/bots/project-a/temp",
      "workspaces": ["/srv/bots/project-a/work"],
      "network": "project-a-egress",
      "user": "1000:1000"
    }
  }
}
```

Register the corresponding instance in the ordinary server configuration:

```json
{
  "instances": {
    "project-a-engine": {
      "driver": "codex",
      "config": { "cli": "codex" }
    }
  }
}
```

The driver is preserved. The same mechanism accepts Claude, Pi, Muse Code, named ACP clients, `customAcp`, and API adapters from the built-in registry. Their normal driver-specific configuration applies **inside the image**. Configure a client executable through the instance’s `config.cli`; the worker policy does not select an executable.

Select this instance for the assigned bot and set its working directory within its declared workspaces. Every configured engine needs an assignment; unassigned engines become unavailable. Sharing one engine instance between bots is refused. Restart after changing the policy. The initial implementation requires a Linux or macOS coordinator and Linux Docker images; Windows coordinator mode is explicitly refused.

Optional `dockerConfig` and `context` select an operator-owned Docker configuration/context. Bind source paths must exist on the Docker daemon's host. This is not an SSH file-transfer implementation. The tested local path uses a colocated coordinator and Docker daemon, including Docker Desktop's host-file sharing; a remote daemon needs separately provisioned matching directories.

### Rootless Docker on Linux

Run the rootless daemon under a dedicated, unprivileged host account with subordinate UID/GID ranges. Choose host and subordinate numeric IDs that do not overlap existing service or container identities; checking only host account names is insufficient because container processes can use host IDs without corresponding accounts. That account needs no membership in the rootful Docker group or access to the rootful Docker socket. Manage its daemon through the user's systemd manager on a cgroup v2 host, with `cpu`, `memory` and `pids` controllers delegated to it. Check that `docker info` reports the intended rootless daemon and the `systemd` cgroup driver. Rootless Docker can ignore resource flags when cgroup support is unavailable; declared container settings alone do not establish enforcement. See [Docker's rootless resource requirements](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources).

The coordinator must share the daemon's user namespace so its filesystem ownership operations use the same IDs as the workers. Rootless container UID 0 maps to the daemon owner's unprivileged host UID; nonzero container IDs map into subordinate host ranges. A host-owned directory therefore appears root-owned inside the container. Running an ordinary host process with the same numeric UID as `worker.user` does not provide matching ownership. See [Docker's UID/GID mapping](https://docs.docker.com/engine/security/rootless/uid-gid-mapping/).

As the daemon owner, enter its existing user and mount namespaces to launch the coordinator. Never invoke this command as host root. From the application directory, with the coordinator's data directory already configured and provisioned for that account:

```sh
nsenter -U --preserve-credentials -m \
  -t "$(cat "${XDG_RUNTIME_DIR:?}/docker.pid")" \
  -- node dist-server/index.js
```

This follows [Docker's namespace entry procedure](https://docs.docker.com/engine/security/rootless/troubleshoot/#tips-for-debugging), selecting user and mount namespaces while retaining the coordinator's host network namespace. Verify that the target PID belongs to the dedicated daemon and that namespace UID/GID 0 map to its nonzero host IDs. The coordinator sees namespace UID 0; its host identity remains unprivileged. Workers retain a nonzero policy user such as `1000:1000`, dropped capabilities and no-new-privileges.

Provision each bot's distinct home, temp and workspace directories using that same namespace and the worker's configured UID/GID. Keep the coordinator data and trusted mount parents outside those mounts. The supervisor creates each private mode-0700 temp generation and assigns its ownership within the matching namespace; it also needs to remove worker-owned contents during cleanup. Do not substitute world-writable directories for correct ownership. Worker images still contain the copied runtime bundle on a read-only root filesystem; neither the host source checkout nor the coordinator's home is mounted into a worker.

Set an absolute `dockerConfig` in the policy, outside every bot mount, and select the dedicated rootless context explicitly. For the smoke helper, pass the same directory through `OMB_DOCKER_CONFIG` and set its current context to that daemon. Clear conflicting ambient Docker endpoint variables before running build/test commands. The supervisor deliberately excludes inherited `DOCKER_HOST` and other Docker environment overrides, so relying on those variables can send verification commands and supervisors to different daemons.

Run the Docker verification below from the same namespace arrangement. Require the worker's actual kernel limits to report 1 GiB memory, 128 PIDs and a CPU quota/period ratio of 1. Missing or unlimited controllers fail qualification. Rootless mode does not alter network authorization: offline workers use `none`; online clients need their own explicit network and provisioned account, with separate operator enforcement for Internet, LAN and host egress restrictions.

## Boundary and deliberate limitations

- Home maps to `/home/agent`; each worker generation gets its own temporary subdirectory mounted at `/tmp`; workspace paths retain their absolute names. A private, size-limited `/run/omb` tmpfs holds IPC sockets; `/tmp` and `TMPDIR` remain on the configured host bind. This avoids Docker Desktop shared-filesystem socket permission limitations without weakening broker permissions. Home/workspace state persists. The root filesystem and runtime are read-only; containers run without root, added capabilities, privilege escalation or the Docker socket, and with CPU/memory/process limits.
- Canonical directory mounts cannot overlap each other or coordinator/administrative directories. Reserved runtime/device destinations are refused. The operator must provision trusted mount parents and exclude preexisting service sockets or other deliberately shared capabilities.
- `network: "none"` is the default. Online clients need an explicitly created dedicated network. A unique Docker network is **not** an Internet/LAN/host firewall. Broader egress restrictions require separate operator enforcement; the integration does not claim to provide them.
- Only explicit per-instance environment reaches the driver. Reserved home, temporary, runtime, control-plane and process-injection variables are refused. The coordinator's global provider keys and normal CLI logins are not automatically copied. Provision the selected account in that bot's home or its explicit instance environment. An agent with shell access can read credentials assigned to its own bot.
- A typed, bounded stdio protocol carries requests/events. Bot, instance, thread and generation authority remain coordinator-owned. Worker process IDs never become host process IDs. Stop terminates that bot’s entire worker and cancels any other active threads in that worker; later work creates a fresh generation after cleanup is confirmed. Other bots are unaffected. Lost or malformed workers fail closed; there is no host execution fallback.
- The host-side bridge exposes only `coordinate_bots` and `assignment_status` with the active turn's existing authorization and tool scope. It retains coordinator credentials outside workers. Delegation exchanges messages/results; it does not grant access to another bot's files or expand the recipient's mounts.
- Host browser/desktop, connected apps, custom host MCP services and hooks are unavailable in this initial mode. Native tools supplied by an installed client run in its worker. Worker event narration cannot trigger host MCP health probes, credential refreshes or screen polling.
- Background title/memory generation, permission-review helpers, cache warming/compaction and interactive account setup are not exposed by this facade. Installation, host CLI testing/discovery, automatic engine updates and guided host account setup are disabled in container mode; manage client binaries in images and account state in the assigned home. Model refresh runs inside the worker.
- Turn paths, including attachments, skills, bot settings and tool-result paths, must resolve within that bot's declared workspaces. Missing output/settings files under a permitted root are allowed. Global attachment/skill stores are not automatically mounted or copied; unsupported paths fail explicitly.
- The coordinator remains trusted with conversation records. This does not make conversations private from the server or isolate one Docker worker from a malicious Docker administrator/kernel.

Run the standalone server with authenticated operator clients. Container mode forces service-level loopback trust and removes ordinary session-less local-service route exemptions; desktop-managed mode is refused. A worker can appear local on Docker Desktop, so network origin is not treated as operator authority.

## Verification

Protocol, policy, registry, control-route and hostile-worker regression checks:

```sh
pnpm exec vitest run server/container-workers server/harness/registry.test.ts
```

The provider matrix executes all registered drivers against simulated executable protocols or controlled HTTP APIs in disposable worker processes. Those are actual driver tests, not installed-client or Docker qualification. Docker tests remain separately labelled and skipped unless explicitly enabled.

After building `dist-server`, run the credential-free Docker proof:

```sh
node scripts/smoke-container-workers.mjs
```

This builds a local image and runs the bundled real Custom ACP driver with a synthetic executable. It checks two workers, host/sibling read/write denial, own-state writes, restart persistence, duplicate-launch ownership, packaged supervisor operation and descendant cleanup after normal and forced termination. It also runs the real coordinator HTTP/delegation proof and the all-adapter matrix in Docker using a separate image with a synthetic loopback model service. It retains credential-free evidence and Vitest JSON reports under `.omb-scratch/verify-evidence/container-workers/`. The helper resolves Docker from `PATH`, or accepts `OMB_DOCKER`, before starting the coordinator's restricted environment. Linux packaged-server CI runs this command after its normal packaged smoke; the equivalent combined Linux lane includes it too.

To select an already built image or Docker installation:

```sh
OMB_DOCKER_TEST=1 OMB_DOCKER=/usr/bin/docker \
OMB_WORKER_IMAGE=omb-container-runtime:dev \
pnpm exec vitest run server/container-workers/docker.test.ts
```

Record the source revision, image digest, platform, client versions, exact checks and any skipped/blocked cases for each qualification. Approval levels retain each client’s native semantics: Ask does not force every native command to prompt. Test an actual emitted request before claiming denial behavior. Full `pnpm typecheck`, `pnpm test`, and `pnpm lint` remain required before submission.
