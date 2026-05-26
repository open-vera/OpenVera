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
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.app-container {
  display: flex;
  height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
}

.sidebar {
  width: 250px;
  background-color: #2c3e50;
  color: white;
  padding: 20px;
}

.nav-link {
  display: block;
  padding: 12px 16px;
  margin: 8px 0;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.nav-link:hover {
  background-color: #34495e;
}

.nav-link.router-link-active {
  background-color: #3498db;
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
</style>
