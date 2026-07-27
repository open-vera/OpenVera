<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";

const preview = usePreviewStore();
const settings = useSettingsStore();

const closeLabel = () =>
  settings.locale === "en" ? "Close preview" : "关闭预览";

function close() {
  preview.closeImageLightbox();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});

watch(
  () => preview.imageLightbox,
  (value) => {
    document.body.style.overflow = value ? "hidden" : "";
  },
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="preview.imageLightbox"
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="closeLabel()"
      @click.self="close"
    >
      <button
        type="button"
        class="lightbox-close"
        :aria-label="closeLabel()"
        @click="close"
      >
        ×
      </button>
      <img
        class="lightbox-image"
        :src="preview.imageLightbox.src"
        :alt="preview.imageLightbox.alt || ''"
        @click.stop
      />
    </div>
  </Teleport>
</template>

<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
}

.lightbox-image {
  max-width: min(96vw, 1200px);
  max-height: 90vh;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  object-fit: contain;
  background: color-mix(in srgb, var(--surface) 40%, transparent);
}

.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-elevated) 88%, transparent);
  color: var(--text);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.lightbox-close:hover {
  background: var(--surface-hover);
}
</style>
