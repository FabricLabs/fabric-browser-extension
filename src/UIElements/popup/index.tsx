'use strict';

// Dependencies
import React from 'react';
import { createRoot } from 'react-dom/client';

// Fabric
import IdentityManager from '../IdentityManager';
import '@fabric/http/assets/semantic.min.css';

const container = document.getElementById('fabric-root');
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <IdentityManager />
  </React.StrictMode>
);
