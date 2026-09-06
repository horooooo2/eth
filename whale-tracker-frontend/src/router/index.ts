import { createRouter, createWebHashHistory } from 'vue-router';
import { isMobileViewport, readViewForce } from '@/utils/device';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'desktop',
      component: () => import('@/views/DesktopApp.vue'),
    },
    {
      path: '/m',
      component: () => import('@/views/mobile/MobileLayout.vue'),
      children: [
        { path: '', redirect: { name: 'm-home' } },
        {
          path: 'home',
          name: 'm-home',
          component: () => import('@/views/mobile/MobileHome.vue'),
        },
        {
          path: 'alerts',
          name: 'm-alerts',
          component: () => import('@/views/mobile/MobileAlerts.vue'),
        },
        {
          path: 'whales',
          redirect: (to) => ({ name: 'm-home', query: to.query }),
        },
        {
          path: 'trades',
          name: 'm-trades',
          component: () => import('@/views/mobile/MobileTrades.vue'),
        },
        {
          path: 'me',
          name: 'm-me',
          component: () => import('@/views/mobile/MobileMe.vue'),
        },
      ],
    },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

router.beforeEach((to) => {
  const force = readViewForce();
  const mobile = isMobileViewport();
  const onMobile = to.path.startsWith('/m');

  if (force === 'mobile' && !onMobile) {
    return { path: '/m/home', query: to.query };
  }
  if (force === 'desktop' && onMobile) {
    return { path: '/', query: to.query };
  }
  if (!force && mobile && !onMobile && to.name === 'desktop') {
    return { path: '/m/home', query: to.query };
  }
  return true;
});

export default router;
