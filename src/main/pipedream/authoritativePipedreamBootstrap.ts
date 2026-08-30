import type { PipedreamBootstrap } from "@/shared/pipedreamBootstrap";

/**
 * Main-process source of truth for every supervisor spawn. A durable
 * credential mutation is committed here synchronously before the live
 * supervisor RPC is attempted, so a lost reply or crash cannot make the next
 * supervisor restart resurrect stale credentials.
 */
export class AuthoritativePipedreamBootstrap {
  #current: PipedreamBootstrap;

  constructor(initial: PipedreamBootstrap = { state: "absent" }) {
    this.#current = initial;
  }

  current(): PipedreamBootstrap {
    return this.#current;
  }

  replace(bootstrap: PipedreamBootstrap): void {
    this.#current = bootstrap;
  }

  configure<Result>(
    bootstrap: PipedreamBootstrap,
    configureSupervisor: (authoritative: PipedreamBootstrap) => Promise<Result>,
  ): Promise<Result> {
    this.#current = bootstrap;
    return configureSupervisor(bootstrap);
  }
}
