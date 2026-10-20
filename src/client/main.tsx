import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './style.css';
const AdminApp = lazy(() => import('./admin/AdminApp'));
const CustomerApp = lazy(() => import('./customer/CustomerApp'));
function App() { return <BrowserRouter><Suspense fallback={<div className="app-loading" role="status">小島醸造 · 読み込み中…</div>}><Routes><Route path="/admin/*" element={<AdminApp/>}/><Route path="/*" element={<CustomerApp/>}/></Routes></Suspense></BrowserRouter>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
