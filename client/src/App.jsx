import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import AppShell, { BrandMark } from './components/AppShell.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Home from './pages/Home.jsx';
import Groups from './pages/Groups.jsx';
import GroupDetail from './pages/GroupDetail.jsx';
import People from './pages/People.jsx';
import PersonDetail from './pages/PersonDetail.jsx';
import Activity from './pages/Activity.jsx';
import ExpenseDetail from './pages/ExpenseDetail.jsx';
import ExpenseForm from './pages/ExpenseForm.jsx';
import SettleUp from './pages/SettleUp.jsx';
import Account from './pages/Account.jsx';
import SetPassword from './pages/SetPassword.jsx';

function Protected({ children }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <BrandMark size={44} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  // Accounts made with a temporary password must pick their own first.
  if (user.mustChangePassword) return <SetPassword />;
  return children;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        {/* Full-screen flows (no tab bar) */}
        <Route path="/expenses/new" element={<Protected><ExpenseForm /></Protected>} />
        <Route path="/expenses/:id/edit" element={<Protected><ExpenseForm /></Protected>} />
        <Route path="/settle" element={<Protected><SettleUp /></Protected>} />
        {/* Main app */}
        <Route element={<Protected><AppShell /></Protected>}>
          <Route index element={<Home />} />
          <Route path="groups" element={<Groups />} />
          <Route path="groups/:id" element={<GroupDetail />} />
          <Route path="people" element={<People />} />
          <Route path="people/:username" element={<PersonDetail />} />
          <Route path="activity" element={<Activity />} />
          <Route path="expenses/:id" element={<ExpenseDetail />} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
