import { createRouter, createWebHashHistory } from 'vue-router';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'desktop',
      component: () => import('@/views/DesktopApp.vue'),
    },
    // 旧手机端入口统一回 PC
    { path: '/m/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

export default router;
