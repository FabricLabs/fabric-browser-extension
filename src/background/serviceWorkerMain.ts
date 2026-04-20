'use strict';

import { registerFabricBackground } from './fabricBackground';

registerFabricBackground();

console.log('[FABRIC] Background service started', chrome.runtime.id);
