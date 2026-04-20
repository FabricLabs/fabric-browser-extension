'use strict';

import React from 'react';
import { HashRouter as Router, Navigate, Routes, Route } from 'react-router-dom';
import { Container } from 'semantic-ui-react';

const FabricInterface = () => {
  return (
    <Container className='fabric application'>
      <Router>
        <Routes>
          <Route path='' element={<Navigate to='home' replace />} />
        </Routes>
      </Router>
    </Container>
  );
}

export default FabricInterface;
