/**
 * `agentRuntimeComponent` — adapt the engine-lib runtime to a
 * `@infinityi/forge/lifecycle` {@link Component} (Phase 8).
 *
 * engine-lib itself is mostly stateless — providers are HTTP clients, sessions
 * live behind a {@link SessionStore} — so this adapter doesn't invent a runtime
 * object. Instead it bundles the pieces an app wires up (providers, an optional
 * session store, telemetry) into the tiny `{ name, start?, stop?, healthcheck? }`
 * seam Forge orchestrates, so the runtime boots and drains cleanly alongside the
 * rest of a Forge application (Principle 6 — composable; Principle 7 — no global
 * state, just a plain object).
 *
 * - `start()` fail-fast validates the config (unique provider names, non-empty
 *   default models) and, if `probeOnStart`, probes every provider so a bad
 *   deployment rolls back during `forge.boot` instead of failing the first run.
 * - `healthcheck()` maps provider probes to a Forge {@link HealthResult}
 *   (`healthy` / `degraded` / `unhealthy`) for readiness/liveness routes.
 * - `stop()` runs the optional `onStop` hook (e.g. flush/close a durable session
 *   store), bounded by the shutdown `signal`.
 *
 * @example
 * ```ts
 * import { forge } from "@infinityi/forge/lifecycle";
 * import { agentRuntimeComponent } from "engine-lib/lifecycle";
 *
 * const app = await forge.boot({
 *   components: [
 *     agentRuntimeComponent({
 *       providers: [openai],
 *       sessionStore: store,
 *       probe: (p, signal) => p.complete({ messages: [user("ping")] }, { signal }).then(() => {}),
 *       probeOnStart: true,
 *       onStop: () => store.close(),
 *     }),
 *   ],
 * });
 * ```
 *
 * @module
 */

import type {
  Component,
  HealthContext,
  HealthResult,
  HealthStatus,
  LifecycleContext,
} from "@infinityi/forge/lifecycle";
import type { Provider } from "../providers/types";
import type { TelemetryHandle } from "../runtime/types";
import type { SessionStore } from "../session/types";

/** Probe a single provider for readiness; rejects/throws when unhealthy. */
export type ProviderProbe = (provider: Provider, signal: AbortSignal) => Promise<void> | void;

/** Configuration for {@link agentRuntimeComponent}. */
export interface AgentRuntimeOptions {
  /** Component id used in logs / health output. Default `"agent-runtime"`. */
  readonly name?: string;
  /** Providers the runtime serves; validated on start and probed on health. */
  readonly providers?: readonly Provider[];
  /** Session store the runtime uses; surfaced for health/reporting. */
  readonly sessionStore?: SessionStore;
  /** Telemetry handle (reserved for runtime wiring; not required). */
  readonly telemetry?: TelemetryHandle;
  /**
   * Optional readiness probe run per provider during `healthcheck` (and during
   * `start` when {@link AgentRuntimeOptions.probeOnStart} is set).
   */
  readonly probe?: ProviderProbe;
  /** Probe every provider during `start`, failing boot if any probe rejects. */
  readonly probeOnStart?: boolean;
  /** Flush/close hook run on `stop` (e.g. close a durable session store). */
  readonly onStop?: (signal: AbortSignal) => Promise<void> | void;
}

const DEFAULT_NAME = "agent-runtime";

/** Validate provider config; throws on a misconfiguration (fail-fast on boot). */
function validateProviders(providers: readonly Provider[]): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (typeof provider.name !== "string" || provider.name.trim() === "") {
      throw new Error("agentRuntimeComponent: every provider must have a non-empty name");
    }
    if (seen.has(provider.name)) {
      throw new Error(`agentRuntimeComponent: duplicate provider name "${provider.name}"`);
    }
    seen.add(provider.name);
    if (typeof provider.defaultModel !== "string" || provider.defaultModel.trim() === "") {
      throw new Error(
        `agentRuntimeComponent: provider "${provider.name}" has an empty defaultModel`,
      );
    }
  }
}

/** Probe every provider, returning the names that failed (with their error). */
async function probeAll(
  providers: readonly Provider[],
  probe: ProviderProbe,
  signal: AbortSignal,
): Promise<Array<{ name: string; error: unknown }>> {
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const provider of providers) {
    try {
      await probe(provider, signal);
    } catch (error) {
      failures.push({ name: provider.name, error });
    }
  }
  return failures;
}

/**
 * Adapt an engine-lib runtime into a Forge lifecycle {@link Component}.
 *
 * The returned object only contributes the seams it can implement: `start`
 * (always), `stop` (always — runs `onStop` when provided), and `healthcheck`
 * (always — a no-op-healthy probe when none is configured).
 */
export function agentRuntimeComponent(opts: AgentRuntimeOptions): Component {
  const name = opts.name ?? DEFAULT_NAME;
  const providers = opts.providers ?? [];
  const { probe, onStop } = opts;

  return {
    name,

    async start(ctx: LifecycleContext): Promise<void> {
      validateProviders(providers);
      if (opts.probeOnStart === true && probe !== undefined) {
        const failures = await probeAll(providers, probe, ctx.signal);
        if (failures.length > 0) {
          const names = failures.map((f) => f.name).join(", ");
          throw new Error(`agentRuntimeComponent: provider probe failed on start for: ${names}`);
        }
      }
      ctx.logger.info("agent runtime started", {
        providers: providers.length,
        sessionStore: opts.sessionStore !== undefined,
      });
    },

    async stop(ctx: LifecycleContext): Promise<void> {
      if (onStop !== undefined) await onStop(ctx.signal);
      ctx.logger.info("agent runtime stopped");
    },

    async healthcheck(ctx: HealthContext): Promise<HealthResult> {
      if (probe === undefined || providers.length === 0) {
        return { status: "healthy", data: { providers: providers.length } };
      }
      const failures = await probeAll(providers, probe, ctx.signal);
      const status: HealthStatus =
        failures.length === 0 ? "healthy" : failures.length < providers.length ? "degraded" : "unhealthy";
      const result: HealthResult = {
        status,
        data: { providers: providers.length, unhealthy: failures.length },
      };
      if (failures.length === 0) return result;
      return { ...result, detail: `provider probe failed: ${failures.map((f) => f.name).join(", ")}` };
    },
  };
}
