import './styles.css';
import './world-events.css';
import './city.css';
import { AppController } from './app/AppController';
import { GameApi } from './app/api';
import { PlayerStore } from './app/state';
import { createPlatformAdapter } from './platform/platform';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('DEGEN could not find #app');

const platform = createPlatformAdapter();
const api = new GameApi();
const store = new PlayerStore(api);
const controller = new AppController(root, store, api);

// Paint the Map before platform identity or the Worker bootstrap request resolves.
// Until initialization completes, the Underpass remains in its safe syncing state.
await controller.start();
void platform.getIdentity()
  .then(async (identity) => {
    const initialized = await store.initialize(identity);
    if (initialized) controller.onPlayerInitialized();
    else controller.onPlayerInitializationFailed();
  })
  .catch((error) => {
    console.warn('DEGEN platform identity could not be initialized.', error);
    controller.onPlayerInitializationFailed();
  });
