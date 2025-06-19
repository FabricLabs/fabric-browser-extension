'use strict';

import React from 'react';
import { Provider } from 'react-redux';

import { store } from './store';
import FabricApplication from './layouts/FabricInterface';

import 'semantic-ui-css/semantic.min.css';
import './styles/global.scss';
import './styles/main.scss';

const Application = () => {
  return (
    <Provider store={store}>
      <FabricApplication />
    </Provider>
  );
};

export default Application;
