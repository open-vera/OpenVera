import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import SpacesView from './views/SpacesView.vue'
import SettingsView from './views/SettingsView.vue'

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
      name: 'dashboard',
      component: DashboardView
    },
    {
      path: '/spaces',
      name: 'spaces',
      component: SpacesView
    },
    {
      path: '/spaces/:scopeId',
      name: 'space-detail',
      component: () => import('./views/SpaceDetailView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView
    }
  ]
})

export default router
