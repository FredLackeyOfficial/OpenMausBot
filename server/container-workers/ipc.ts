/** Provisioned by the trusted launcher, never accepted from provider configuration.
 * Docker Desktop bind mounts cannot reliably chmod Unix sockets; IPC uses a private tmpfs.
 */
export function workerIpcDirectory(): string | undefined {
  return process.env.OMB_CONTAINER_IPC_DIR === "/run/omb" ? "/run/omb" : undefined;
}
