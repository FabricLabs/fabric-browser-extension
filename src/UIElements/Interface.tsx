'use strict';

import React, { useState, useEffect } from 'react';
import { Container } from 'semantic-ui-react';

// Components
import Navigation from './components/Navigation';

// Pages
import WelcomePage from './pages/Welcome';
import SettingsPage from './pages/Settings';
import HelpPage from './pages/Help';
import AboutPage from './pages/About';
import IdentityManager from './popup/IdentityManager';

const Interface: React.FC = () => {
  const [activePage, setActivePage] = useState('home');
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);

  useEffect(() => {
    // Check if user has completed onboarding
    chrome.storage.local.get(['onboardingComplete'], (result) => {
      const v = result.onboardingComplete;
      setHasCompletedOnboarding(v === true);
    });
  }, []);

  const handlePageChange = (page: string) => {
    setActivePage(page);
  };

  const handleOnboardingComplete = () => {
    setHasCompletedOnboarding(true);
    chrome.storage.local.set({ onboardingComplete: true });
  };

  const renderPage = () => {
    if (!hasCompletedOnboarding) {
      return <WelcomePage onComplete={handleOnboardingComplete} />;
    }

    switch (activePage) {
      case 'home':
      case 'identities':
      case 'transactions':
        return <IdentityManager />;
      case 'settings':
        return <SettingsPage />;
      case 'help':
        return <HelpPage />;
      case 'about':
        return <AboutPage />;
      default:
        return <IdentityManager />;
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#1b1c1d' }}>
      {hasCompletedOnboarding && (
        <Navigation activePage={activePage} onPageChange={handlePageChange} />
      )}
      <Container style={{ paddingTop: hasCompletedOnboarding ? '4em' : '1em' }}>
        {renderPage()}
      </Container>
    </div>
  );
};

export default Interface; 