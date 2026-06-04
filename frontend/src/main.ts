import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import DashboardView from './views/DashboardView.vue'
import CaptureView from './views/CaptureView.vue'
import LoginView from './views/LoginView.vue'
import { isLoggedIn } from './services/auth'
import './styles.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/capture', component: CaptureView },
    { path: '/', component: DashboardView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !isLoggedIn()) {
    return '/login'
  }
})

createApp(App).use(router).mount('#app')
