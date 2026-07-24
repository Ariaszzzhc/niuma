// The single fetch entry point for every HTTP request niuma sends to an LLM
// provider. It stamps `user-agent: niuma/<version>` so the whole agent identifies
// itself consistently, no matter which adapter makes the call — providers stay
// responsible only for their own auth and content-type headers.
//
// `VERSION` is this package's only @niuma/config dependency. It is a build-time
// constant (the root deno.json version, embedded in compiled binaries), not
// runtime configuration, so it does not violate the package's "no config
// loading / no env reads here" isolation.
//
// `init` is typed as `globalThis.RequestInit` (the DOM lib member that carries
// `headers`) rather than left to `typeof fetch` inference: the workspace's
// deno.window+deno.unstable+dom lib mix makes the inferred param a union whose
// plain `RequestInit` member omits `headers`, so reading it inline fails to
// type-check.
import { VERSION } from "@niuma/config";

const USER_AGENT = `niuma/${VERSION}`;

export const niumaFetch = (
  input: string | URL | Request,
  init?: globalThis.RequestInit,
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    // Normalise whatever HeadersInit form the caller passed (Headers, pairs, or
    // a plain object) into a plain object with lowercased keys.
    for (const [k, v] of new Headers(init.headers)) headers[k] = v;
  }
  // Forced, not defaulted: every request niuma sends carries the niuma UA, even
  // if a caller tries to set one.
  headers["user-agent"] = USER_AGENT;
  return fetch(input, { ...init, headers });
};
