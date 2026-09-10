import { useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import OAuthConsent from './pages/OAuthConsent';
import VpsProbe from './pages/VpsProbe';


/**
 * Where an anonymous visitor is sent. Uses the SDK's own redirect rather than `<Navigate to=
 * "/login">` so the return URL survives — it appends `?from_url=…`, which is what brings someone
 * back to the page they asked for after signing in.
 */
const SendToLogin = () => {
  const { navigateToLogin } = useAuth();
  useEffect(() => {
    navigateToLogin();
  }, [navigateToLogin]);
  return null;
};
const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      {/*
        The auth pages the scaffold ships in src/pages/. They MUST be routed: the SDK's
        `redirectToLogin()` sends the browser to /login?from_url=…, so without these every
        sign-in attempt lands on PageNotFound — a 404 that looks like a broken app and is really a
        missing line here. Paths match what the SDK and the platform's page_names expect.
      */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/oauth-consent" element={<OAuthConsent />} />

      {/*
        Everything past this point requires a session. Enforced ONCE here rather than per page:
        the app's platform visibility is `public_without_login`, so without a guard an anonymous
        visitor reaches a real page, its ops fail with 401, and the screen fills with errors
        instead of a login prompt — which is exactly what happened on the probe.

        The VPS is the real boundary and refuses anything without an approved identity, so this
        guard is about the app behaving sanely, not about protecting data.
      */}
      <Route element={<ProtectedRoute unauthenticatedElement={<SendToLogin />} />}>
        {/*
          `/` needs a route of its own. Without one the root falls through to the catch-all and
          renders `The page "" could not be found` — exactly what a user sees straight after
          signing in, because the SDK returns them to the app root. Points at the probe until the
          real dashboard lands.
        */}
        <Route path="/" element={<Navigate to="/vps-probe" replace />} />
        <Route path="/vps-probe" element={<VpsProbe />} />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
