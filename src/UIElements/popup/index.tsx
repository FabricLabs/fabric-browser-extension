'use strict';

// Dependencies
import React from 'react';
import { createRoot } from 'react-dom/client';

// Fabric
import IdentityManager from '../IdentityManager';
import '@fabric/http/assets/semantic.min.css';

const container = document.getElementById('fabric-root');

// Approvals happen here: never inside another page's frame.
if (window.top === window && container) {
  createRoot(container).render(
    <React.StrictMode>
      <IdentityManager />
    </React.StrictMode>
  );
}
