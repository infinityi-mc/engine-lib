/**
 * `@infinityi/engine-lib/lifecycle` — Forge lifecycle integration (Phase 8).
 *
 * Opt-in subpath that adapts the engine-lib runtime to a
 * `@infinityi/forge/lifecycle` component via {@link agentRuntimeComponent},
 * so the runtime starts, health-checks, and drains inside a Forge app. Importing
 * it is the only thing that pulls in the forge lifecycle surface.
 *
 * @module
 */

export { agentRuntimeComponent } from "./component";
export type { AgentRuntimeOptions, ProviderProbe } from "./component";
