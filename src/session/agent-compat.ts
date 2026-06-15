import type { AgentDefinition } from "../agent/types";
import { SessionAgentMismatchError, type SessionAgentIdentity } from "../errors";
import type { SessionResumeInfo } from "./resume";

export function activeToolNames(agent: AgentDefinition): readonly string[] {
  return [...(agent.tools ?? [])]
    .map((tool) => tool.name)
    .filter((name) => !name.startsWith("transfer_to_"))
    .sort((a, b) => a.localeCompare(b));
}

export function compareAgentResume(
  resume: SessionResumeInfo | undefined,
  agent: AgentDefinition,
):
  | undefined
  | {
      readonly expected: SessionAgentIdentity;
      readonly actual: SessionAgentIdentity;
    } {
  if (resume === undefined) return undefined;
  const expected: SessionAgentIdentity = {
    ...(resume.agentVersion !== undefined
      ? { version: resume.agentVersion }
      : {}),
    toolNames: [...(resume.toolNames ?? [])].sort((a, b) => a.localeCompare(b)),
  };
  const actual: SessionAgentIdentity = {
    ...(agent.version !== undefined ? { version: agent.version } : {}),
    toolNames: [...activeToolNames(agent)],
  };
  const sameVersion =
    resume.agentVersion === undefined || expected.version === actual.version;
  const sameTools =
    resume.toolNames === undefined ||
    (expected.toolNames.length === actual.toolNames.length &&
      expected.toolNames.every((name, index) => name === actual.toolNames[index]));
  if (sameVersion && sameTools) return undefined;
  return { expected, actual };
}

export function assertAgentResumeCompatible(
  resume: SessionResumeInfo | undefined,
  agent: AgentDefinition,
): void {
  const mismatch = compareAgentResume(resume, agent);
  if (mismatch === undefined) return;
  throw new SessionAgentMismatchError("session agent/tool mismatch", mismatch);
}
