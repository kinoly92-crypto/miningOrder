import { Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import MainLayout from './components/MainLayout';
import AuditLogPage from './pages/AuditLogPage';
import Board from './pages/Board';
import DispatchForm from './pages/DispatchForm';
import Ledger from './pages/Ledger';
import Login from './pages/Login';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="boot">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/board" replace /> : <Login />} />
      <Route element={user ? <MainLayout /> : <Navigate to="/login" replace />}>
        <Route path="/" element={<Navigate to="/board" replace />} />
        <Route path="/board" element={<Board />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route
          path="/dispatch/new"
          element={user?.role === 'director' || user?.role === 'admin' ? <DispatchForm /> : <Navigate to="/board" replace />}
        />
        <Route
          path="/audit"
          element={user?.role === 'director' || user?.role === 'admin' ? <AuditLogPage /> : <Navigate to="/board" replace />}
        />
        <Route path="*" element={<Navigate to="/board" replace />} />
      </Route>
    </Routes>
  );
}
