import { createRouter, createWebHashHistory } from 'vue-router';
import { STRATEGY_WORKSPACE_ENABLED } from '@/utils/featureFlags';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    ...(STRATEGY_WORKSPACE_ENABLED
      ? [{ path: '/tradfi-replay', name: 'tradfi-replay', component: () => import('@/views/TradFiReplay.vue') }]
      : [{ path: '/tradfi-replay', redirect: '/' }]),
    {
      path: '/',
      name: 'desktop',
      component: () => import('@/views/DesktopApp.vue'),
    },
    {
      path: '/console',
      component: () => import('@/views/console/ManagementLayout.vue'),
      redirect: '/console/data',
      children: [
        {
          path: 'data',
          name: 'console-data',
          component: () => import('@/views/console/ConsoleDataDashboard.vue'),
        },
      ],
    },
    { path: '/data.html', redirect: '/console/data' },
    // 旧手机端入口统一回 PC
    { path: '/m/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

export default router;
