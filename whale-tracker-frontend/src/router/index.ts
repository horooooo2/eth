import { createRouter, createWebHashHistory } from 'vue-router';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
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
        {
          path: 'strategy-config',
          name: 'console-strategy-config',
          component: () => import('@/views/console/ConsoleStrategyConfig.vue'),
        },
      ],
    },
    { path: '/data.html', redirect: '/console/data' },
    { path: '/strategy-config.html', redirect: '/console/strategy-config' },
    { path: '/consolestrategy-config.html', redirect: '/console/strategy-config' },
    // 旧手机端入口统一回 PC
    { path: '/m/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

export default router;
