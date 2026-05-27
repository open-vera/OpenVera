<template>
  <div class="app-container">
    <button class="sidebar-toggle" @click="sidebarOpen = !sidebarOpen">
      {{ sidebarOpen ? '✕' : '☰' }}
    </button>
    <div class="sidebar-overlay" v-if="sidebarOpen" @click="sidebarOpen = false"></div>
    <header class="sidebar" :class="{ open: sidebarOpen }">
      <nav>
        <router-link to="/" class="nav-link" @click="sidebarOpen = false">📊 Dashboard</router-link>
        <router-link to="/spaces" class="nav-link" @click="sidebarOpen = false">📦 Spaces</router-link>
        <router-link to="/settings" class="nav-link" @click="sidebarOpen = false">⚙️ Settings</router-link>
      </nav>
    </header>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const sidebarOpen = ref(false);
</script>

<style>
.sidebar-toggle {
  display: none;
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 200;
  width: 40px;
  height: 40px;
  background-color: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 20px;
  cursor: pointer;
}

.sidebar-overlay {
  display: none;
}

@media (max-width: 768px) {
  .sidebar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .sidebar-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 99;
  }

  .sidebar {
    position: fixed;
    top: 0;
    left: -260px;
    height: 100vh;
    z-index: 100;
    transition: left 0.25s ease;
  }

  .sidebar.open {
    left: 0;
  }

  .content {
    padding-top: 60px;
  }
}
</style>
