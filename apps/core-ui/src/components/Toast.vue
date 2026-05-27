<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="visible" class="toast" :class="type">
        {{ message }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  message: string;
  type?: 'success' | 'danger' | 'info';
  duration?: number;
}>();

const visible = defineModel<boolean>('visible', { default: false });

let timer: ReturnType<typeof setTimeout> | undefined;

watch(visible, (val) => {
  if (val) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      visible.value = false;
    }, props.duration ?? 2000);
  }
});
</script>

<style scoped>
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 20px;
  border-radius: 6px;
  font-size: 14px;
  color: #fff;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}

.toast.success {
  background-color: var(--success);
}

.toast.danger {
  background-color: var(--danger);
}

.toast.info {
  background-color: var(--accent);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
