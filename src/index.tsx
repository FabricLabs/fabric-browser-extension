'use strict';

// Dependencies
import React from 'react';
import { createRoot } from 'react-dom/client';

// Components
import FabricApplication from './FabricApplication';

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <FabricApplication />
  </React.StrictMode>
);
