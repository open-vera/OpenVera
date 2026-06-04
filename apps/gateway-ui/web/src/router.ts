import { createRouter, createWebHistory } from "vue-router";
import OverviewView from "./views/OverviewView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ProjectDetailView from "./views/ProjectDetailView.vue";
import CapabilitiesView from "./views/CapabilitiesView.vue";
import CostView from "./views/CostView.vue";
import DoctorView from "./views/DoctorView.vue";
import ExecutionView from "./views/ExecutionView.vue";
import ManagementView from "./views/ManagementView.vue";
import OperationsView from "./views/OperationsView.vue";
import RunsWorkspaceView from "./views/RunsWorkspaceView.vue";
import RunShell from "./views/run/RunShell.vue";
import RunOverviewTab from "./views/run/RunOverviewTab.vue";
import RunMemoryTab from "./views/run/RunMemoryTab.vue";
import RunCheckpointsTab from "./views/run/RunCheckpointsTab.vue";
import RunSubagentsTab from "./views/run/RunSubagentsTab.vue";
import RunTimelineTab from "./views/run/RunTimelineTab.vue";
import ChatView from "./views/ChatView.vue";
import CapabilityKindView from "./views/CapabilityKindView.vue";
import SettingsView from "./views/SettingsView.vue";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "overview", component: OverviewView },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:projectId", name: "project-detail", component: ProjectDetailView },
    { path: "/capabilities", name: "capabilities", component: CapabilitiesView },
    { path: "/cost", name: "cost", component: CostView },
    { path: "/chat", name: "chat", component: ChatView },
    { path: "/chat/:conversationId", name: "chat-detail", component: ChatView },
    {
      path: "/skills",
      name: "skills",
      component: CapabilityKindView,
      props: {
        kind: "skill",
        title: "Skills",
        description: "项目与全局技能目录、热重载入口。",
        manageAction: "skill.reload",
      },
    },
    { path: "/mcp", name: "mcp", component: () => import("./views/McpView.vue") },
    { path: "/rag", name: "rag", component: () => import("./views/RagView.vue") },
    { path: "/management", name: "management", component: ManagementView },
    { path: "/execution", name: "execution", component: ExecutionView },
    { path: "/operations", name: "operations", component: OperationsView },
    { path: "/doctor", name: "doctor", component: DoctorView },
    {
      path: "/runs",
      component: RunsWorkspaceView,
      children: [
        {
          path: ":runId",
          component: RunShell,
          children: [
            { path: "", name: "run-overview", component: RunOverviewTab },
            { path: "memory", name: "run-memory", component: RunMemoryTab },
            { path: "checkpoints", name: "run-checkpoints", component: RunCheckpointsTab },
            { path: "subagents", name: "run-subagents", component: RunSubagentsTab },
            { path: "timeline", name: "run-timeline", component: RunTimelineTab },
          ],
        },
      ],
    },
    { path: "/settings", name: "settings", component: SettingsView },
  ],
});

export default router;
