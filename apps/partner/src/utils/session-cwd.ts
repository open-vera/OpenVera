import {
  projectNameFromRootPath,
  SETTINGS_TAB_ID,
  type PartnerProjectRecord,
  type PartnerSessionRecord,
} from "./partner-app-state.js";

export interface SessionCwdInput {
  activeTabId: string | null;
  sessions: Record<string, PartnerSessionRecord>;
  projects: PartnerProjectRecord[];
  workspaceRootPath: string;
}

export interface SessionCwdResult {
  cwd: string;
  label: string;
}

function folderLabel(rootPath: string, projectName?: string): string {
  const name = projectName?.trim() || projectNameFromRootPath(rootPath);
  return name || "Terminal";
}

/**
 * Resolve terminal cwd from the active session's project, falling back to workspace root.
 */
export function resolveSessionCwd(input: SessionCwdInput): SessionCwdResult {
  const workspaceRoot = input.workspaceRootPath.trim();
  const tabId = input.activeTabId;

  if (tabId && tabId !== SETTINGS_TAB_ID) {
    const session = input.sessions[tabId];
    if (session?.projectId) {
      const project = input.projects.find((item) => item.id === session.projectId);
      if (project?.rootPath.trim()) {
        return {
          cwd: project.rootPath,
          label: folderLabel(project.rootPath, project.name),
        };
      }
    }
  }

  if (workspaceRoot) {
    return {
      cwd: workspaceRoot,
      label: folderLabel(workspaceRoot),
    };
  }

  return { cwd: "", label: "Terminal" };
}
