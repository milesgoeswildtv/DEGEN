import './styles.css';
import { AppController } from './app/AppController';
import { PlayerStore } from './app/state';
import { createPlatformAdapter } from './platform/platform';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('DEGEN could not find #app');

const platform = createPlatformAdapter();
const identity = await platform.getIdentity();
const store = new PlayerStore();

if (store.snapshot.displayName === 'Player' && identity.displayName !== 'Player') {
  store.setDisplayName(identity.displayName);
}

new AppController(root, store).start();
