import { createRouter, createWebHistory } from 'vue-router'
import RunsView from './views/RunsView.vue'
import RunDetailView from './views/RunDetailView.vue'
import MemoryView from './views/MemoryView.vue'
import CheckpointsView from './views/CheckpointsView.vue'
import SubagentsView from './views/SubagentsView.vue'

declare global {
  interface ImportMeta {
    env: {
      BASE_URL: string;
    };
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'runs',
      component: RunsView
    },
    {
      path: '/runs/:runId',
      name: 'run-detail',
      component: RunDetailView,
      children: [
        {
          path: 'memory',
          name: 'run-memory',
          component: MemoryView
        },
        {
          path: 'checkpoints',
          name: 'run-checkpoints',
          component: CheckpointsView
        },
        {
          path: 'subagents',
          name: 'run-subagents',
          component: SubagentsView
        }
      ]
    }
  ]
})

export default router
