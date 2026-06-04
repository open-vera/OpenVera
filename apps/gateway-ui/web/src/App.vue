<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">V</div>
        <div>
          <h1>Vera Gateway</h1>
          <p>Control Plane</p>
        </div>
      </div>

      <nav class="nav">
        <router-link to="/" class="nav-link">Overview</router-link>
        <router-link to="/projects" class="nav-link">Projects</router-link>
        <router-link to="/capabilities" class="nav-link">Capabilities</router-link>
        <router-link to="/skills" class="nav-link">Skills</router-link>
        <router-link to="/mcp" class="nav-link">MCP</router-link>
        <router-link to="/rag" class="nav-link">RAG</router-link>
        <router-link to="/runs" class="nav-link">Runs</router-link>
        <router-link to="/chat" class="nav-link">Chat</router-link>
        <router-link to="/cost" class="nav-link">Cost</router-link>
        <router-link to="/operations" class="nav-link">Operations</router-link>
        <router-link to="/management" class="nav-link">Management</router-link>
        <router-link to="/execution" class="nav-link">Execution</router-link>
        <router-link to="/doctor" class="nav-link">Doctor</router-link>
        <router-link to="/settings" class="nav-link">Settings</router-link>
      </nav>
    </aside>

    <main class="content">
      <router-view />
    </main>
  </div>
</template>
