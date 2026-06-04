<template>
  <section>
    <div class="page-header">
      <div>
        <h2>对话</h2>
        <p>项目级会话；消息经 Gateway 记录，后续可接入 Core LLM runtime。</p>
      </div>
    </div>

    <div class="chat-layout">
      <aside class="card sidebar">
        <label class="field">
          <span>项目</span>
          <select v-model="selectedProjectId" @change="onProjectChange">
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
        </label>
        <button class="button" @click="newConversation">新对话</button>
        <router-link
          v-for="item in conversations"
          :key="item.id"
          class="conv-item"
          :class="{ active: activeId === item.id }"
          :to="`/chat/${item.id}`"
        >
          {{ item.title }}
        </router-link>
      </aside>

      <article class="card chat-panel">
        <p v-if="error" class="error">{{ error }}</p>
        <p v-else-if="!activeConversation" class="muted">选择或创建对话</p>
        <div v-else class="messages">
          <div v-for="message in activeConversation.messages" :key="message.id" class="message" :class="message.role">
            <span class="role">{{ message.role }}</span>
            <p>{{ message.content }}</p>
          </div>
        </div>
        <form v-if="activeConversation" class="composer" @submit.prevent="send">
          <input v-model="draft" placeholder="输入消息..." />
          <button type="submit" :disabled="sending || !draft.trim()">发送</button>
        </form>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { gatewayApi, type Conversation, type GatewayProject } from "../api";

const route = useRoute();
const router = useRouter();
const projects = ref<GatewayProject[]>([]);
const conversations = ref<Conversation[]>([]);
const activeConversation = ref<Conversation>();
const selectedProjectId = ref("");
const draft = ref("");
const sending = ref(false);
const error = ref("");

const activeId = computed(() => (route.params.conversationId ? String(route.params.conversationId) : ""));

async function loadProjects(): Promise<void> {
  projects.value = await gatewayApi.projects.list();
  if (!selectedProjectId.value && projects.value[0]) {
    selectedProjectId.value = projects.value[0].id;
  }
}

async function loadConversations(): Promise<void> {
  if (!selectedProjectId.value) return;
  conversations.value = await gatewayApi.conversations.list(selectedProjectId.value);
}

async function loadActive(): Promise<void> {
  if (!activeId.value) {
    activeConversation.value = undefined;
    return;
  }
  activeConversation.value = await gatewayApi.conversations.get(activeId.value);
}

async function onProjectChange(): Promise<void> {
  await loadConversations();
  if (conversations.value[0]) {
    await router.push(`/chat/${conversations.value[0].id}`);
  } else {
    await router.push("/chat");
  }
}

async function newConversation(): Promise<void> {
  if (!selectedProjectId.value) return;
  const created = await gatewayApi.conversations.create(selectedProjectId.value);
  await loadConversations();
  await router.push(`/chat/${created.id}`);
}

async function send(): Promise<void> {
  if (!activeConversation.value || !draft.value.trim()) return;
  sending.value = true;
  error.value = "";
  try {
    const result = await gatewayApi.conversations.sendMessage(activeConversation.value.id, draft.value);
    activeConversation.value = result.conversation;
    draft.value = "";
    await loadConversations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "发送失败";
  } finally {
    sending.value = false;
  }
}

onMounted(async () => {
  try {
    await loadProjects();
    await loadConversations();
    if (activeId.value) await loadActive();
    else if (conversations.value[0]) await router.replace(`/chat/${conversations.value[0].id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  }
});

watch(activeId, () => {
  void loadActive().catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : "加载对话失败";
  });
});

watch(selectedProjectId, () => {
  void onProjectChange();
});
</script>

<style scoped>
.chat-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}

.field select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
  color: var(--text);
}

.button {
  width: 100%;
  margin-bottom: 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px;
  color: var(--accent);
  background: var(--accent-dim);
  cursor: pointer;
}

.conv-item {
  display: block;
  padding: 8px 0;
  color: var(--text-muted);
  text-decoration: none;
  border-bottom: 1px solid var(--border);
}

.conv-item.active {
  color: var(--accent);
}

.chat-panel {
  display: flex;
  flex-direction: column;
  min-height: 480px;
}

.messages {
  flex: 1;
  overflow: auto;
  padding: 8px 0;
}

.message {
  margin-bottom: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--surface-2);
}

.message.user {
  border-left: 3px solid var(--accent);
}

.message.assistant {
  border-left: 3px solid var(--success);
}

.role {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
}

.composer {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.composer input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--bg);
  color: var(--text);
}

.composer button {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 16px;
  background: var(--surface-2);
  cursor: pointer;
}
</style>
