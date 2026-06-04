<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Settings</h2>
        <p>原 Admin Settings 合入到 Gateway 后，这里先展示只读配置入口和后续管理动作。</p>
      </div>
    </div>

    <div class="grid cols-2">
      <article class="card">
        <h3>Configuration</h3>
        <p>Provider、model、routing、session、MCP server 配置将通过 Gateway Config Manager 管理。</p>
        <p class="muted">敏感值只展示脱敏状态，不直接显示 API key。</p>
      </article>
      <article class="card">
        <h3>Management Actions</h3>
        <p>下一阶段接入 reload skill、reload MCP、RAG reindex、channel connect、sandbox test。</p>
      </article>
      <article class="card">
        <h3>Legacy UI Merge</h3>
        <p>Admin/Core/Harness 的前端入口已合入 Gateway UI，旧 web 包可以从 workspace 移除。</p>
      </article>
      <article class="card">
        <h3>Service Boundary</h3>
        <p>旧 server 暂留作为底层 API，Gateway Server 会逐步吸收或代理这些能力。</p>
      </article>
    </div>
  </section>
</template>
