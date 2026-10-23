import './styles.css';
import './world-events.css';
import { AppController } from './app/AppController';
import { GameApi } from './app/api';
import { PlayerStore } from './app/state';
import { createPlatformAdapter } from './platform/platform';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('DEGEN could not find #app');

const api = new GameApi();
const platform = createPlatformAdapter(api);
const store = new PlayerStore(api);

try {
  const identity = await platform.getIdentity();
  if (api.enabled && identity.platform === 'browser') {
    throw new Error('Open DEGEN through its Telegram Mini App or Discord Activity. Browser preview is available only without a Worker API.');
  }
  await store.initialize(identity);
  await new AppController(root, store, api).start();
} catch (error) {
  console.error('DEGEN authentication failed.', error);
  root.innerHTML = `<main role="alert" class="auth-error">
    <h1>DEGEN sign-in failed</h1>
    <p>Open DEGEN from Telegram or Discord and try again. Server-backed gameplay will not start without a verified platform identity.</p>
  </main>`;
}
