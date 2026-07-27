<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import { useAppStateStore } from "@/stores/app-state";
import { useSettingsStore } from "@/stores/settings";
import { formatChatTime } from "@/utils/chat-time";
import type { PartnerProjectRecord, PartnerSessionRecord } from "@/utils/partner-app-state";

const emit = defineEmits<{
  selectSession: [sessionId: string];
  newSession: [projectId: string | null];
}>();

const appState = useAppStateStore();
const settings = useSettingsStore();
const { projects, orphanSessions, activeTabId } = storeToRefs(appState);

const uiText = computed(() =>
  settings.locale === "en"
    ? {
        orphans: "Sessions",
        empty: "No sessions yet",
        projectEmptyPrefix: "No sessions yet. ",
        projectEmptyAction: "New chat",
        newUnder: "New chat in project",
      }
    : {
        orphans: "会话",
        empty: "暂无会话",
        projectEmptyPrefix: "暂无会话，可",
        projectEmptyAction: "新建会话",
        newUnder: "在此项目新建对话",
      },
);

function previewOf(session: PartnerSessionRecord): string {
  const message = [...session.messages].reverse().find((item) => item.content.trim());
  if (!message) return settings.locale === "en" ? "Empty" : "空会话";
  return message.content.trim().replace(/\s+/g, " ").slice(0, 64);
}

function toggleProject(project: PartnerProjectRecord) {
  appState.toggleProjectExpanded(project.id);
}

function onSelect(sessionId: string) {
  emit("selectSession", sessionId);
}

function sessionsOf(projectId: string): PartnerSessionRecord[] {
  return appState.sessionsForProject(projectId);
}

function onNewInProject(projectId: string, event: Event) {
  event.stopPropagation();
  emit("newSession", projectId);
}
</script>

<template>
  <div class="session-tree">
    <div v-if="orphanSessions.length" class="block">
      <div
        v-for="session in orphanSessions"
        :key="session.id"
        class="session-row"
        :class="{ active: activeTabId === session.id }"
        role="button"
        tabindex="0"
        @click="onSelect(session.id)"
        @keydown.enter="onSelect(session.id)"
      >
        <span class="session-title">{{ session.title }}</span>
        <span class="session-meta">{{ formatChatTime(session.updatedAt) }}</span>
        <span class="session-preview">{{ previewOf(session) }}</span>
      </div>
    </div>

    <div v-for="project in projects" :key="project.id" class="block project-block">
      <button type="button" class="project-row" @click="toggleProject(project)">
        <span class="chevron" aria-hidden="true">
          <ChevronIcon :expanded="project.expanded" />
        </span>
        <span class="project-name">{{ project.name }}</span>
        <span
          class="project-new"
          :title="uiText.newUnder"
          @click="onNewInProject(project.id, $event)"
        >
          +
        </span>
      </button>
      <div v-if="project.expanded" class="project-sessions">
        <template v-if="sessionsOf(project.id).length">
          <div
            v-for="session in sessionsOf(project.id)"
            :key="session.id"
            class="session-row nested"
            :class="{ active: activeTabId === session.id }"
            role="button"
            tabindex="0"
            @click="onSelect(session.id)"
            @keydown.enter="onSelect(session.id)"
          >
            <span class="session-title">{{ session.title }}</span>
            <span class="session-meta">{{ formatChatTime(session.updatedAt) }}</span>
            <span class="session-preview">{{ previewOf(session) }}</span>
          </div>
        </template>
        <p v-else class="project-empty">
          {{ uiText.projectEmptyPrefix }}<button
            type="button"
            class="project-empty-action"
            @click="onNewInProject(project.id, $event)"
          >{{ uiText.projectEmptyAction }}</button>
        </p>
      </div>
    </div>

    <p
      v-if="!orphanSessions.length && !projects.length"
      class="empty"
    >
      {{ uiText.empty }}
    </p>
  </div>
</template>

<style scoped>
.session-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 8px 6px 12px;
  overflow-y: auto;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.project-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}

.project-row:hover {
  background: var(--surface-hover);
}

.chevron {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 14px;
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
}

.project-new:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.project-sessions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 10px;
}

.project-empty {
  margin: 0;
  padding: 6px 8px 8px 18px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.project-empty-action {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.project-empty-action:hover {
  color: var(--text);
}

.session-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  border-radius: 6px;
  padding: 7px 8px;
  cursor: pointer;
}

.session-row:hover {
  background: var(--surface-hover);
}

.session-row.active {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-hover));
}

.session-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.session-meta {
  color: var(--text-muted);
  font-size: 10px;
}

.session-preview {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 11px;
}

.empty {
  margin: 24px 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
</style>
