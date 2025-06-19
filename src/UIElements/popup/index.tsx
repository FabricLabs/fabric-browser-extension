'use strict';

// Dependencies
import React from 'react';
import { createRoot } from 'react-dom/client';

// Fabric
import IdentityManager from '../IdentityManager';

// Semantic UI
import 'semantic-ui-css/semantic.min.css';

const container = document.getElementById('fabric-root');
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <IdentityManager />
  </React.StrictMode>
);