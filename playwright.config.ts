import { defineConfig, devices } from '@playwright/test';
import { testDatabase } from './tests/support/database.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error(
    'Set TEST_DATABASE_URL to a disposable database ending in _test before browser tests.',
  );
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command:
      'node --import tsx tests/support/browser-setup.ts && npm run start:server',
    url: 'http://127.0.0.1:3100/health/live',
    reuseExistingServer: false,
    env: {
      DATABASE_URL: testDatabase().connection('runtime'),
      NODE_ENV: 'test',
      APP_ORIGIN: 'http://127.0.0.1:3100',
      ALLOW_INSECURE_LOOPBACK: 'true',
      HOST: '127.0.0.1',
      PORT: '3100',
      LOG_LEVEL: 'silent',
    },
  },
});
