import { createRouter, createWebHashHistory } from 'vue-router';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/console',
    },
    {
      path: '/console',
      component: () => import('@/layouts/ManagementLayout.vue'),
      children: [
        {
          path: '',
          name: 'console-overview',
          component: () => import('@/views/console/ConsoleOverview.vue'),
        },
        {
          path: 'control',
          name: 'console-control',
          component: () => import('@/views/console/ConsoleStrategyControl.vue'),
        },
        {
          path: 'config',
          name: 'console-config',
          component: () => import('@/views/console/ConsoleStrategyConfig.vue'),
        },
        {
          path: 'logs',
          name: 'console-logs',
          component: () => import('@/views/console/ConsoleRuntimeLogs.vue'),
        },
        {
          path: 'data',
          name: 'console-data',
          component: () => import('@/views/console/ConsoleDataDashboard.vue'),
        },
        {
          path: 'status',
          name: 'console-status',
          component: () => import('@/views/console/ConsoleSystemStatus.vue'),
        },
      ],
    },
    {
      path: '/whales',
      name: 'whales',
      component: () => import('@/views/DesktopApp.vue'),
    },
    { path: '/m/:pathMatch(.*)*', redirect: '/console' },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

export default router;
