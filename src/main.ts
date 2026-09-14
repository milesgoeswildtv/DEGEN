import './styles.css';
import './world-events.css';
import { AppController } from './app/AppController';
import { GameApi } from './app/api';
import { PlayerStore } from './app/state';
import { createPlatformAdapter } from './platform/platform';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('DEGEN could not find #app');

const platform = createPlatformAdapter();
const identity = await platform.getIdentity();
const api = new GameApi();
const store = new PlayerStore(api);
await store.initialize(identity);

await new AppController(root, store, api).start();
