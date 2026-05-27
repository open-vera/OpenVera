<template>
  <div class="app-container">
    <header class="sidebar">
      <nav>
        <router-link to="/" class="nav-link">📊 Dashboard</router-link>
        <router-link to="/spaces" class="nav-link">📦 Spaces</router-link>
        <router-link to="/settings" class="nav-link">⚙️ Settings</router-link>
      </nav>
    </header>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
</script>

<style>
/* Theme variables and global styles are in style.css */
</style>
