// Server-owned runtime configuration.
//
// The server is the only runtime participant that reads, digests, or writes
// config.toml. Clients receive the sanitized ClientConfigView below and may
// request an explicit input-delivery update; they never inspect config files.
// No watcher or implicit reload exists: an explicit successful write updates
// this process's snapshot, while other already-running niuma Workers keep their
// own snapshots until restart or their own explicit update.

import type { ClientConfigView, InputDelivery } from "@niuma/schema";
import {
  DEFAULT_INPUT_DELIVERY,
  type NiumaConfig,
  writeInputDelivery,
} from "@niuma/config";

export interface ConfigurationRuntime {
  /** Current sanitized view; synchronous so prompt admission can sample it
   * inside the SessionManager's per-session critical section. */
  readonly clientConfig: () => ClientConfigView;
  /** Persist, then publish, a new delivery mode. Concurrent updates are
   * serialized in request order within this Server. */
  readonly setInputDelivery: (
    inputDelivery: InputDelivery,
  ) => Promise<ClientConfigView>;
}

export interface ConfigurationRuntimeOptions {
  readonly config: NiumaConfig;
  readonly workspace: string;
  readonly globalConfigPath: string;
  /** Tests with injected configuration can keep updates in-memory. */
  readonly persist?: boolean;
}

export const makeConfigurationRuntime = (
  opts: ConfigurationRuntimeOptions,
): ConfigurationRuntime => {
  let inputDelivery = opts.config.inputDelivery ?? DEFAULT_INPUT_DELIVERY;
  let tail: Promise<void> = Promise.resolve();

  const clientConfig = (): ClientConfigView => ({ inputDelivery });

  const serialize = async <A>(work: () => Promise<A>): Promise<A> => {
    const previous = tail;
    let release = (): void => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const setInputDelivery = (
    next: InputDelivery,
  ): Promise<ClientConfigView> =>
    serialize(async () => {
      if (opts.persist !== false) {
        await writeInputDelivery(
          opts.globalConfigPath,
          opts.workspace,
          next,
        );
      }
      // Publish only after persistence succeeds. A failed write leaves both
      // the file and this Server's authoritative snapshot unchanged.
      inputDelivery = next;
      return clientConfig();
    });

  return { clientConfig, setInputDelivery };
};
